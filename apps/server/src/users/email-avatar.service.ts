import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Imports a user's profile picture from an email-keyed avatar service
 * (Gravatar, Libravatar) when they already have one set up there.
 *
 * The lookup happens ON THE SERVER and the result is copied into our own R2
 * bucket, deliberately. Rendering `<img src="https://gravatar.com/avatar/...">`
 * in the browser would be three lines instead of this file, but it would also
 * hand Automattic a hit from every viewer's IP on every page, carrying the
 * email hash of everyone else in the member list they happen to be looking at.
 * Those hashes are not anonymous — a plain digest of a well-known address is
 * reversible by rainbow table. Fetching once from here means the avatar
 * services only ever see this server, once per user per recheck window.
 */

interface Hashes {
  sha256: string;
  md5: string;
}

interface Provider {
  id: string;
  url: (hash: Hashes, size: number) => string;
}

const PROVIDERS: Provider[] = [
  // Libravatar first: federated, privacy-focused, and it can itself fall back
  // to Gravatar for addresses it does not host.
  {
    id: 'libravatar',
    url: (h, s) => `https://seccdn.libravatar.org/avatar/${h.md5}?s=${s}&d=404`,
  },
  {
    id: 'gravatar',
    // Gravatar moved to SHA-256; MD5 still resolves but is the legacy path.
    url: (h, s) => `https://gravatar.com/avatar/${h.sha256}?s=${s}&d=404`,
  },
];

const SIZE = 256;
const RECHECK_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BYTES = 2 * 1024 * 1024;
// Libravatar serves `image/jpg` where Gravatar serves `image/jpeg`. Omitting
// the non-standard spelling silently rejected every Libravatar hit.
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
]);

@Injectable()
export class EmailAvatarService {
  private readonly logger = new Logger(EmailAvatarService.name);

  private s3Client: S3Client | null = null;

  private bucketName?: string;

  private publicUrl?: string;

  // One in-flight resolve per user. Several requests land at once on sign-in
  // and each would otherwise fire its own probe at the avatar services.
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(private readonly prisma: PrismaService) {}

  private enabled(): boolean {
    return process.env.EMAIL_AVATAR_LOOKUP !== 'false';
  }

  private providers(): Provider[] {
    const raw = (process.env.EMAIL_AVATAR_PROVIDERS || '').trim();
    if (!raw) return PROVIDERS;
    const wanted = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    return wanted
      .map((id) => PROVIDERS.find((p) => p.id === id))
      .filter((p): p is Provider => Boolean(p));
  }

  private initS3() {
    if (this.s3Client) return;
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    this.bucketName = process.env.R2_BUCKET_NAME;
    if (!accountId || !accessKeyId || !secretAccessKey || !this.bucketName) return;
    this.publicUrl = process.env.R2_PUBLIC_URL || `https://pub-${accountId}.r2.dev`;
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  private static hashes(email: string): Hashes {
    // Both services key on the lowercased, trimmed address.
    const normalized = email.trim().toLowerCase();
    return {
      sha256: createHash('sha256').update(normalized).digest('hex'),
      md5: createHash('md5').update(normalized).digest('hex'),
    };
  }

  /**
   * Resolve and cache an email avatar for a user, if one is due.
   *
   * Safe to call on every sign-in: it no-ops for users who uploaded their own
   * picture, who deleted one, or who were checked inside the recheck window.
   * Never throws — a failed lookup just leaves the generated mascot in place.
   */
  async ensure(user: {
    id: string;
    email: string;
    imageUrl: string | null;
    imageSource: string | null;
    avatarCheckedAt: Date | null;
  }): Promise<string | null> {
    if (!this.enabled()) return user.imageUrl;
    // An upload always wins, and 'none' means they explicitly removed one.
    if (user.imageSource === 'upload' || user.imageSource === 'none') return user.imageUrl;
    if (
      user.avatarCheckedAt &&
      Date.now() - user.avatarCheckedAt.getTime() < RECHECK_MS
    ) {
      return user.imageUrl;
    }

    const inFlight = this.pending.get(user.id);
    if (inFlight) return inFlight;

    const task = this.resolve(user).catch((err) => {
      this.logger.warn(
        `email avatar lookup failed for ${user.id}: ${err instanceof Error ? err.message : err}`,
      );
      return user.imageUrl;
    });
    this.pending.set(user.id, task);
    try {
      return await task;
    } finally {
      this.pending.delete(user.id);
    }
  }

  private async resolve(user: {
    id: string;
    email: string;
    imageUrl: string | null;
  }): Promise<string | null> {
    const hashes = EmailAvatarService.hashes(user.email);

    for (const provider of this.providers()) {
      const found = await this.fetchFrom(provider, hashes);
      if (!found) continue;

      const stored = await this.store(hashes.sha256, found);
      if (!stored) break;

      await this.prisma.user.update({
        where: { id: user.id },
        data: { imageUrl: stored, imageSource: 'gravatar', avatarCheckedAt: new Date() },
      });
      this.logger.log(`imported ${provider.id} avatar for user ${user.id}`);
      return stored;
    }

    // Record the miss so we don't re-probe on every single sign-in.
    await this.prisma.user.update({
      where: { id: user.id },
      data: { avatarCheckedAt: new Date() },
    });
    return user.imageUrl;
  }

  /** `d=404` is the documented way to ask "is one actually set?" — no placeholder. */
  private async fetchFrom(
    provider: Provider,
    hashes: Hashes,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(provider.url(hashes, SIZE), {
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok) return null;

      const contentType = (res.headers.get('content-type') || '').split(';')[0].trim();
      if (!ALLOWED_TYPES.has(contentType)) return null;

      const declared = Number(res.headers.get('content-length') || '0');
      if (declared > MAX_BYTES) return null;

      const body = Buffer.from(await res.arrayBuffer());
      if (!body.length || body.length > MAX_BYTES) return null;
      return { body, contentType };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  private async store(
    hash: string,
    found: { body: Buffer; contentType: string },
  ): Promise<string | null> {
    this.initS3();
    if (!this.s3Client || !this.bucketName) {
      this.logger.warn('R2 is not configured; skipping email avatar import');
      return null;
    }
    const ext = found.contentType.split('/')[1].replace('jpeg', 'jpg');
    // Keyed by hash + time so a user changing their Gravatar busts the
    // immutable cache instead of serving the old picture forever.
    const key = `users/email-avatar/${hash}-${Date.now().toString(36)}.${ext}`;
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: found.body,
        ContentType: found.contentType,
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return `${this.publicUrl}/${key}`;
  }
}
