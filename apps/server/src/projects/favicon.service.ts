import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { PrismaService } from '../prisma/prisma.service';
import { LeaderElectionService } from '../events/leader-election.service';
import {
  externalUploadStorage,
  objectStorageGeneration,
  s3ClientConfig
} from '../instance-config/object-storage';
import { reencodeImage } from '../organizations/image-reencode';
import { assertPublicUrl, guardedFetch } from '../notifications/webhook-guard';

const FETCH_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; OrchardBot/1.0)' };
const HOP_TIMEOUT_MS = 5000;

const STORABLE_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/svg+xml',
  'image/x-icon',
  'image/vnd.microsoft.icon'
]);

@Injectable()
export class FaviconService {
  private readonly logger = new Logger(FaviconService.name);

  private s3Client: S3Client | null = null;

  private bucketName: string | null = null;

  private publicUrl: string | null = null;

  private keyPrefix = '';

  // In-memory cache to avoid repeated R2 checks within the same process lifetime
  private memoryCache = new Map<string, { url: string | null; ts: number }>();

  // Same idea for og:image banners (key: domain)
  private bannerCache = new Map<string, { url: string | null; ts: number }>();

  private static MAX_INPUT_PIXELS = 16_000_000;
  private static MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;
  private static MEMORY_TTL = 24 * 60 * 60 * 1000; // 24h in-memory

  private pendingFetches = new Map<string, Promise<string | null>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly leaderElection: LeaderElectionService
  ) {}

  private s3InitAt = -1;

  private initS3() {
    const generation = objectStorageGeneration();
    if (this.s3Client && this.s3InitAt === generation) return;
    this.s3InitAt = generation;

    const target = externalUploadStorage();
    if (!target) {
      this.s3Client = null;
      return;
    }

    this.bucketName = target.bucket;
    this.publicUrl = target.publicUrl;
    this.keyPrefix = target.keyPrefix;

    this.s3Client = new S3Client(s3ClientConfig(target));
  }

  /**
   * Does an object exist in R2? Uses ListObjectsV2 rather than HeadObject on
   * purpose: HeadObject throws NotFound (a 404) for a missing key, and since
   * the common case here is a cold/uncached domain, that turned every miss
   * into an errored AWS span that dd-trace surfaced in Error Tracking as
   * noise. ListObjectsV2 returns 200 with empty Contents on a miss: no
   * exception, no error span. Genuine R2 failures still throw and are still
   * reported, which is correct.
   */
  private async objectExists(key: string): Promise<boolean> {
    if (!this.s3Client || !this.bucketName) return false;
    const res = await this.s3Client.send(
      new ListObjectsV2Command({
        Bucket: this.bucketName,
        Prefix: `${this.keyPrefix}${key}`,
        MaxKeys: 1
      })
    );
    return res.Contents?.some((o) => o.Key === `${this.keyPrefix}${key}`) ?? false;
  }

  /**
   * Get a favicon URL for the given domain.
   * Returns the R2 public URL if cached, or fetches + stores it.
   * Returns null if no favicon could be found.
   */
  async getFavicon(domain: string): Promise<string | null> {
    const cached = this.memoryCache.get(domain);
    if (cached && Date.now() - cached.ts < FaviconService.MEMORY_TTL) {
      return cached.url;
    }

    this.initS3();

    const r2Key = `favicons/${domain}.png`;

    if (this.s3Client && this.bucketName) {
      try {
        if (await this.objectExists(r2Key)) {
          const url = `${this.publicUrl}/${r2Key}`;
          this.memoryCache.set(domain, { url, ts: Date.now() });
          return url;
        }
      } catch (err) {
        // R2 lookup failed: fall through and try to (re)fetch it.
        this.logger.warn(
          `R2 lookup failed for ${domain}: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    // Deduplicate concurrent fetches for the same domain
    if (this.pendingFetches.has(domain)) {
      return this.pendingFetches.get(domain)!;
    }

    const fetchPromise = this.fetchAndStore(domain, r2Key);
    this.pendingFetches.set(domain, fetchPromise);

    try {
      return await fetchPromise;
    } finally {
      this.pendingFetches.delete(domain);
    }
  }

  /**
   * Non-blocking favicon lookup for bulk callers (e.g. the org overview).
   * Returns the URL when it is already known (memory cache or R2); on a cold
   * domain it kicks off the slow fetch-and-store in the background and
   * returns null so the caller never waits on an external site.
   */
  async peekFavicon(domain: string): Promise<string | null> {
    const cached = this.memoryCache.get(domain);
    if (cached && Date.now() - cached.ts < FaviconService.MEMORY_TTL) {
      return cached.url;
    }

    this.initS3();
    if (!this.s3Client || !this.bucketName) return null;

    const r2Key = `favicons/${domain}.png`;
    try {
      if (await this.objectExists(r2Key)) {
        const url = `${this.publicUrl}/${r2Key}`;
        this.memoryCache.set(domain, { url, ts: Date.now() });
        return url;
      }
    } catch (err) {
      this.logger.warn(
        `peekFavicon R2 lookup failed for ${domain}: ${err instanceof Error ? err.message : err}`
      );
    }
    // Not in R2 (or lookup failed): warm it in the background, don't block.
    if (!this.pendingFetches.has(domain)) {
      const p = this.fetchAndStore(domain, r2Key);
      this.pendingFetches.set(domain, p);
      p.catch(() => null).finally(() => this.pendingFetches.delete(domain));
    }
    return null;
  }

  /**
   * Force a re-fetch of a domain's favicon, overwriting any R2 copy.
   * Used when an ingress is created/updated and by the daily refresh job.
   * On failure the stale memory entry is dropped (not nulled) so readers
   * fall back to the existing R2 object instead of losing a working icon.
   */
  async refreshFavicon(domain: string): Promise<string | null> {
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(domain)) return null;
    const existing = this.pendingFetches.get(domain);
    if (existing) return existing;

    this.initS3();
    const r2Key = `favicons/${domain}.png`;
    const p = this.fetchAndStore(domain, r2Key);
    this.pendingFetches.set(domain, p);
    try {
      const url = await p;
      if (!url) this.memoryCache.delete(domain);
      return url;
    } finally {
      this.pendingFetches.delete(domain);
    }
  }

  /**
   * Daily sweep: re-fetch favicons for every ingress host so changed icons
   * propagate and newly-reachable sites get picked up.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async refreshAllFavicons() {
    if (!this.leaderElection.isLeader()) return;
    let rows: { host: string | null }[];
    try {
      rows = await this.prisma.ingress.findMany({ select: { host: true } });
    } catch (err) {
      this.logger.warn(
        `Favicon refresh: failed to list ingresses: ${err instanceof Error ? err.message : err}`
      );
      return;
    }
    const domains = [
      ...new Set(
        rows
          .map((r) => r.host?.split('/')[0]?.toLowerCase())
          .filter((d): d is string => !!d && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d))
      )
    ];
    this.logger.log(`Daily favicon refresh: ${domains.length} domains`);
    const BATCH = 5;
    for (let i = 0; i < domains.length; i += BATCH) {
      await Promise.all(
        domains.slice(i, i + BATCH).map((d) => this.refreshFavicon(d).catch(() => null))
      );
    }
    this.logger.log('Daily favicon refresh complete');
  }

  /** Resolve many domains at once without blocking on cold fetches. */
  async peekFavicons(domains: string[]): Promise<Record<string, string | null>> {
    const unique = [...new Set(domains)];
    const entries = await Promise.all(
      unique.map(async (d) => [d, await this.peekFavicon(d)] as const)
    );
    return Object.fromEntries(entries);
  }

  private async fetchAndStore(domain: string, r2Key: string): Promise<string | null> {
    try {
      const origin = await assertPublicUrl(`https://${domain}`, 'Domain');
      const fetchPage = (url: URL) =>
        guardedFetch(url, {
          signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
          headers: FETCH_HEADERS,
          redirect: 'manual'
        });

      let response = await fetchPage(origin);
      for (let hop = 0; hop < 3 && response.status >= 300 && response.status < 400; hop++) {
        const loc = response.headers.get('location');
        if (!loc) break;
        let next: URL;
        try {
          next = new URL(loc, origin);
        } catch {
          break;
        }
        if (next.protocol !== 'https:' || next.hostname.toLowerCase() !== domain.toLowerCase()) {
          this.logger.warn(`Not following cross-origin redirect from ${domain} → ${next.hostname}`);
          break;
        }
        response = await fetchPage(next);
      }

      const html = response.ok ? await response.text() : '';

      // Banner (og:image / twitter:image) rides along on the same HTML fetch.
      // Fire-and-forget: banner failures must never affect the favicon result.
      void this.storeBanner(domain, html).catch(() => {});

      const iconUrl = html ? this.parseIconFromHtml(html, domain) : null;
      if (!iconUrl) {
        // Try /favicon.ico as last resort
        const fallbackUrl = `https://${domain}/favicon.ico`;
        const iconData = await this.downloadImage(fallbackUrl);
        if (iconData) {
          return await this.storeToR2(domain, r2Key, iconData.buffer, iconData.contentType);
        }
        this.memoryCache.set(domain, { url: null, ts: Date.now() });
        return null;
      }

      const iconData = await this.downloadImage(iconUrl);
      if (!iconData) {
        this.memoryCache.set(domain, { url: null, ts: Date.now() });
        return null;
      }

      return await this.storeToR2(domain, r2Key, iconData.buffer, iconData.contentType);
    } catch (err) {
      this.logger.warn(
        `Failed to fetch favicon for ${domain}: ${err instanceof Error ? err.message : err}`
      );
      this.memoryCache.set(domain, { url: null, ts: Date.now() });
      return null;
    }
  }

  private resolveHtmlUrl(href: string, domain: string): string {
    if (href.startsWith('//')) return `https:${href}`;
    if (href.startsWith('/')) return `https://${domain}${href}`;
    if (!/^https?:/i.test(href)) return `https://${domain}/${href}`;
    return href;
  }

  /** Extract the page's social-preview image (og:image > twitter:image). */
  private parseBannerFromHtml(html: string, domain: string): string | null {
    const candidates: { url: string; priority: number }[] = [];
    const metaRegex = /<meta\s[^>]*>/gi;
    for (let m = metaRegex.exec(html); m !== null; m = metaRegex.exec(html)) {
      const tag = m[0];
      const prop = tag.match(/(?:property|name)=["']([^"']+)["']/i)?.[1]?.toLowerCase();
      if (!prop) continue;
      let priority = -1;
      if (prop === 'og:image' || prop === 'og:image:url' || prop === 'og:image:secure_url')
        priority = 2;
      else if (prop === 'twitter:image' || prop === 'twitter:image:src') priority = 1;
      if (priority < 0) continue;
      const content = tag.match(/content=["']([^"']+)["']/i)?.[1];
      if (!content) continue;
      candidates.push({ url: this.resolveHtmlUrl(content, domain), priority });
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => b.priority - a.priority);
    return candidates[0].url;
  }

  private async resizeBanner(buffer: Buffer): Promise<{ buffer: Buffer; contentType: string }> {
    const image = await reencodeImage(buffer, {
      format: 'webp',
      maxDimension: 1280,
      maxPixels: FaviconService.MAX_INPUT_PIXELS,
      allowSvg: true
    });
    return { buffer: image.buffer, contentType: image.contentType };
  }

  /** Download + store the page's og:image banner. Keyed banners/<domain>.png */
  private async storeBanner(domain: string, html: string): Promise<void> {
    const setNull = () => {
      this.bannerCache.set(domain, { url: null, ts: Date.now() });
    };
    try {
      const bannerUrl = html ? this.parseBannerFromHtml(html, domain) : null;
      if (!bannerUrl) return setNull();
      const img = await this.downloadImage(bannerUrl);
      if (!img) return setNull();
      if (!this.s3Client || !this.bucketName) return setNull();
      const { buffer, contentType } = await this.resizeBanner(img.buffer);
      const key = `banners/${domain}.png`;
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: `${this.keyPrefix}${key}`,
          Body: buffer,
          ContentType: contentType,
          CacheControl: 'public, max-age=604800' // 7 days
        })
      );
      const url = `${this.publicUrl}/${key}`;
      this.logger.log(`Cached banner for ${domain} → ${url}`);
      this.bannerCache.set(domain, { url, ts: Date.now() });
    } catch (err) {
      this.logger.warn(
        `Failed to store banner for ${domain}: ${err instanceof Error ? err.message : err}`
      );
      setNull();
    }
  }

  /**
   * Non-blocking banner lookup, mirroring peekFavicon: memory cache → R2
   * HEAD → background fetch (shared with the favicon pipeline) + null.
   */
  async peekBanner(domain: string): Promise<string | null> {
    const cached = this.bannerCache.get(domain);
    if (cached && Date.now() - cached.ts < FaviconService.MEMORY_TTL) {
      return cached.url;
    }

    this.initS3();
    if (!this.s3Client || !this.bucketName) return null;

    const key = `banners/${domain}.png`;
    let missing = false;
    try {
      if (await this.objectExists(key)) {
        const url = `${this.publicUrl}/${key}`;
        this.bannerCache.set(domain, { url, ts: Date.now() });
        return url;
      }
      missing = true;
    } catch (err) {
      this.logger.warn(
        `peekBanner R2 lookup failed for ${domain}: ${err instanceof Error ? err.message : err}`
      );
    }
    // Not in R2 (or lookup failed): fetchAndStore extracts the banner
    // alongside the favicon.
    let pending = this.pendingFetches.get(domain);
    if (!pending) {
      pending = this.fetchAndStore(domain, `favicons/${domain}.png`);
      const p = pending;
      this.pendingFetches.set(domain, p);
      p.catch(() => null).finally(() => this.pendingFetches.delete(domain));
    }
    if (missing) {
      pending
        .catch(() => null)
        .finally(() => {
          if (!this.bannerCache.has(domain)) {
            this.bannerCache.set(domain, { url: null, ts: Date.now() });
          }
        });
    }
    return null;
  }

  /** Resolve many banner domains at once without blocking on cold fetches. */
  async peekBanners(domains: string[]): Promise<Record<string, string | null>> {
    const unique = [...new Set(domains)];
    const entries = await Promise.all(
      unique.map(async (d) => [d, await this.peekBanner(d)] as const)
    );
    return Object.fromEntries(entries);
  }

  private parseIconFromHtml(html: string, domain: string): string | null {
    const icons: { url: string; size: number; priority: number }[] = [];

    // Match <link> tags with icon-related rel attributes
    // Handles both rel-before-href and href-before-rel orderings
    const linkRegex = /<link\s[^>]*>/gi;

    for (
      let linkMatch = linkRegex.exec(html);
      linkMatch !== null;
      linkMatch = linkRegex.exec(html)
    ) {
      const tag = linkMatch[0];

      const relMatch = tag.match(/rel=["']([^"']+)["']/i);
      if (!relMatch) continue;
      const rel = relMatch[1].toLowerCase();

      const isIcon =
        rel === 'icon' ||
        rel === 'shortcut icon' ||
        rel === 'apple-touch-icon' ||
        rel === 'apple-touch-icon-precomposed';
      if (!isIcon) continue;

      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      let href = hrefMatch[1];

      if (href.startsWith('//')) {
        href = `https:${href}`;
      } else if (href.startsWith('/')) {
        href = `https://${domain}${href}`;
      } else if (!href.startsWith('http')) {
        href = `https://${domain}/${href}`;
      }

      const sizeMatch = tag.match(/sizes=["'](\d+)x\d+["']/i);
      const size = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

      // Priority: apple-touch-icon > icon with sizes > icon without sizes
      let priority = 0;
      if (rel.includes('apple-touch-icon')) priority = 2;
      else if (size > 0) priority = 1;

      icons.push({ url: href, size, priority });
    }

    if (icons.length === 0) return null;

    // Sort: highest priority first, then largest size
    icons.sort((a, b) => b.priority - a.priority || b.size - a.size);
    return icons[0].url;
  }

  private async downloadImage(
    url: string
  ): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
      let res: Response;
      try {
        res = await guardedFetch(url, {
          signal: AbortSignal.timeout(HOP_TIMEOUT_MS),
          headers: FETCH_HEADERS,
          maxRedirects: 3
        });
      } catch (e: any) {
        this.logger.warn(`Refusing to fetch image from ${url}: ${e?.message || e}`);
        return null;
      }
      if (!res.ok) return null;

      const contentType = res.headers.get('content-type') || 'image/png';

      // Only accept image content types
      if (!STORABLE_IMAGE_TYPES.has(contentType.split(';')[0].trim().toLowerCase())) {
        return null;
      }

      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > FaviconService.MAX_DOWNLOAD_BYTES) return null;
      const arrayBuffer = await res.arrayBuffer();
      if (arrayBuffer.byteLength > FaviconService.MAX_DOWNLOAD_BYTES) return null;
      const buffer = Buffer.from(arrayBuffer);

      // Sanity check: at least 100 bytes (skip empty/error responses)
      if (buffer.length < 100) return null;

      return { buffer, contentType };
    } catch {
      return null;
    }
  }

  // Icons are only ever stored as PNG bytes the server produced itself from
  // successfully decoded pixels. Anything that fails to decode is rejected.
  private async resizeIcon(buffer: Buffer): Promise<{ buffer: Buffer; contentType: string }> {
    const image = await reencodeImage(buffer, {
      format: 'png',
      maxDimension: 64,
      maxPixels: FaviconService.MAX_INPUT_PIXELS,
      allowSvg: true
    });
    const dematted = await this.trimWhiteMatte(image.buffer);
    return { buffer: dematted, contentType: 'image/png' };
  }

  // Many favicons ship with an opaque white matte that looks like a white
  // box on tinted dashboard tiles. Flood-fill from the borders and clear
  // only the connected near-white region, so white INSIDE the artwork
  // (highlights, text) survives. Skipped unless the corners are white.
  private async trimWhiteMatte(buffer: Buffer): Promise<Buffer> {
    try {
      const sharp = (await import('sharp')).default;
      const { data, info } = await sharp(buffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const { width, height, channels } = info;
      if (channels !== 4 || width < 4 || height < 4) return buffer;

      const px = (x: number, y: number) => (y * width + x) * channels;
      const nearWhite = (i: number) =>
        data[i] >= 240 && data[i + 1] >= 240 && data[i + 2] >= 240 && data[i + 3] >= 250;

      const corners = [px(0, 0), px(width - 1, 0), px(0, height - 1), px(width - 1, height - 1)];
      if (corners.filter(nearWhite).length < 3) return buffer;

      const visited = new Uint8Array(width * height);
      const queue: number[] = [];
      const enqueue = (x: number, y: number) => {
        const p = y * width + x;
        if (!visited[p] && nearWhite(p * channels)) {
          visited[p] = 1;
          queue.push(p);
        }
      };
      for (let x = 0; x < width; x++) {
        enqueue(x, 0);
        enqueue(x, height - 1);
      }
      for (let y = 0; y < height; y++) {
        enqueue(0, y);
        enqueue(width - 1, y);
      }
      while (queue.length > 0) {
        const p = queue.pop()!;
        const x = p % width;
        const y = Math.floor(p / width);
        data[p * channels + 3] = 0;
        if (x > 0) enqueue(x - 1, y);
        if (x < width - 1) enqueue(x + 1, y);
        if (y > 0) enqueue(x, y - 1);
        if (y < height - 1) enqueue(x, y + 1);
      }

      return await sharp(data, { raw: { width, height, channels: 4 } })
        .png()
        .toBuffer();
    } catch {
      return buffer;
    }
  }

  private async storeToR2(
    domain: string,
    key: string,
    buffer: Buffer,
    contentType: string
  ): Promise<string | null> {
    if (!this.s3Client || !this.bucketName) {
      // R2 not configured: return the original URL from memory
      this.logger.warn("R2 not configured, can't cache favicon");
      this.memoryCache.set(domain, { url: null, ts: Date.now() });
      return null;
    }

    const icon = await this.resizeIcon(buffer).catch(() => null);
    if (!icon) {
      this.memoryCache.set(domain, { url: null, ts: Date.now() });
      return null;
    }
    const { buffer: finalBuffer, contentType: finalContentType } = icon;

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: `${this.keyPrefix}${key}`,
          Body: finalBuffer,
          ContentType: finalContentType,
          CacheControl: 'public, max-age=604800' // 7 days
        })
      );

      const url = `${this.publicUrl}/${key}`;
      this.logger.log(`Cached favicon for ${domain} → ${url}`);
      this.memoryCache.set(domain, { url, ts: Date.now() });
      return url;
    } catch (err) {
      this.logger.error(
        `Failed to store favicon for ${domain}: ${err instanceof Error ? err.message : err}`
      );
      this.memoryCache.set(domain, { url: null, ts: Date.now() });
      return null;
    }
  }
}
