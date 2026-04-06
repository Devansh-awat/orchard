import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class FaviconService {
  private readonly logger = new Logger(FaviconService.name);
  private s3Client: S3Client | null = null;
  private bucketName: string | null = null;
  private publicUrl: string | null = null;

  // In-memory cache to avoid repeated R2 checks within the same process lifetime
  private memoryCache = new Map<string, { url: string | null; ts: number }>();
  private static MEMORY_TTL = 60 * 60 * 1000; // 1h in-memory
  private pendingFetches = new Map<string, Promise<string | null>>();

  constructor(private readonly prisma: PrismaService) {}

  private initS3() {
    if (this.s3Client) return;

    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKeyId = process.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME;

    if (!accountId || !accessKeyId || !secretAccessKey || !bucket) {
      this.logger.warn('R2 not configured — favicon caching disabled');
      return;
    }

    this.bucketName = bucket;
    this.publicUrl = process.env.R2_PUBLIC_URL || `https://pub-${accountId}.r2.dev`;

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /**
   * Get a favicon URL for the given domain.
   * Returns the R2 public URL if cached, or fetches + stores it.
   * Returns null if no favicon could be found.
   */
  async getFavicon(domain: string): Promise<string | null> {
    // Check memory cache
    const cached = this.memoryCache.get(domain);
    if (cached && Date.now() - cached.ts < FaviconService.MEMORY_TTL) {
      return cached.url;
    }

    this.initS3();

    const r2Key = `favicons/${domain}.png`;

    // Check if already in R2
    if (this.s3Client && this.bucketName) {
      try {
        await this.s3Client.send(new HeadObjectCommand({
          Bucket: this.bucketName,
          Key: r2Key,
        }));
        // Exists in R2
        const url = `${this.publicUrl}/${r2Key}`;
        this.memoryCache.set(domain, { url, ts: Date.now() });
        return url;
      } catch {
        // Not in R2 yet — fetch it
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

  private async fetchAndStore(domain: string, r2Key: string): Promise<string | null> {
    try {
      // Fetch the page HTML from the domain
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      const response = await fetch(`https://${domain}`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrchardBot/1.0)' },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      const html = await response.text();

      // Parse icon URLs from HTML
      const iconUrl = this.parseIconFromHtml(html, domain);
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

      // Download the icon
      const iconData = await this.downloadImage(iconUrl);
      if (!iconData) {
        this.memoryCache.set(domain, { url: null, ts: Date.now() });
        return null;
      }

      return await this.storeToR2(domain, r2Key, iconData.buffer, iconData.contentType);
    } catch (err) {
      this.logger.warn(`Failed to fetch favicon for ${domain}: ${err instanceof Error ? err.message : err}`);
      this.memoryCache.set(domain, { url: null, ts: Date.now() });
      return null;
    }
  }

  private parseIconFromHtml(html: string, domain: string): string | null {
    const icons: { url: string; size: number; priority: number }[] = [];

    // Match <link> tags with icon-related rel attributes
    // Handles both rel-before-href and href-before-rel orderings
    const linkRegex = /<link\s[^>]*>/gi;
    let linkMatch: RegExpExecArray | null;

    while ((linkMatch = linkRegex.exec(html)) !== null) {
      const tag = linkMatch[0];

      // Check if it's an icon link
      const relMatch = tag.match(/rel=["']([^"']+)["']/i);
      if (!relMatch) continue;
      const rel = relMatch[1].toLowerCase();

      const isIcon = rel === 'icon' || rel === 'shortcut icon' ||
        rel === 'apple-touch-icon' || rel === 'apple-touch-icon-precomposed';
      if (!isIcon) continue;

      // Extract href
      const hrefMatch = tag.match(/href=["']([^"']+)["']/i);
      if (!hrefMatch) continue;
      let href = hrefMatch[1];

      // Resolve relative URLs
      if (href.startsWith('//')) {
        href = 'https:' + href;
      } else if (href.startsWith('/')) {
        href = `https://${domain}${href}`;
      } else if (!href.startsWith('http')) {
        href = `https://${domain}/${href}`;
      }

      // Size hint
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

  private async downloadImage(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrchardBot/1.0)' },
        redirect: 'follow',
      });
      clearTimeout(timeout);

      if (!res.ok) return null;

      const contentType = res.headers.get('content-type') || 'image/png';

      // Only accept image content types
      if (!contentType.startsWith('image/') && !contentType.includes('icon')) {
        return null;
      }

      const arrayBuffer = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Sanity check: at least 100 bytes (skip empty/error responses)
      if (buffer.length < 100) return null;

      return { buffer, contentType };
    } catch {
      return null;
    }
  }

  private async storeToR2(domain: string, key: string, buffer: Buffer, contentType: string): Promise<string | null> {
    if (!this.s3Client || !this.bucketName) {
      // R2 not configured — return the original URL from memory
      this.logger.warn('R2 not configured, cannot cache favicon');
      this.memoryCache.set(domain, { url: null, ts: Date.now() });
      return null;
    }

    try {
      await this.s3Client.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        CacheControl: 'public, max-age=604800', // 7 days
      }));

      const url = `${this.publicUrl}/${key}`;
      this.logger.log(`Cached favicon for ${domain} → ${url}`);
      this.memoryCache.set(domain, { url, ts: Date.now() });
      return url;
    } catch (err) {
      this.logger.error(`Failed to store favicon for ${domain}: ${err instanceof Error ? err.message : err}`);
      this.memoryCache.set(domain, { url: null, ts: Date.now() });
      return null;
    }
  }
}
