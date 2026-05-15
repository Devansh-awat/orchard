import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import * as dns from 'dns';
import * as net from 'net';

// Suffixes that resolve only on internal networks. We never make HTTP
// requests to these — even if the domain regex passes.
const FORBIDDEN_DOMAIN_SUFFIXES = [
  '.cluster.local',
  '.svc',
  '.svc.cluster.local',
  '.internal',
  '.local',
  '.consul',
  '.localhost',
];

const FORBIDDEN_DOMAIN_EXACT = new Set([
  'localhost',
  'metadata',
  'metadata.google.internal',
]);

/**
 * Return true for IPv4/IPv6 addresses that point to private, loopback,
 * link-local, ULA, multicast, reserved, or otherwise-unroutable space.
 * Rejecting these defends against SSRF (cloud metadata, in-cluster services,
 * RFC1918 hosts, etc.) when the caller resolves a user-supplied hostname.
 */
function isPrivateAddress(addr: string): boolean {
  const family = net.isIP(addr);
  if (family === 4) {
    const parts = addr.split('.').map((p) => parseInt(p, 10));
    if (parts.length !== 4 || parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) {
      return true; // malformed → reject
    }
    const [a, b] = parts;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 10.0.0.0/8
    if (a === 10) return true;
    // 127.0.0.0/8 loopback
    if (a === 127) return true;
    // 169.254.0.0/16 link-local (incl. AWS/GCP metadata 169.254.169.254)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.0.0.0/24 IETF protocol assignments
    if (a === 192 && b === 0 && parts[2] === 0) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 198.18.0.0/15 benchmarking
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 224.0.0.0/4 multicast
    if (a >= 224 && a <= 239) return true;
    // 240.0.0.0/4 reserved + 255.255.255.255 broadcast
    if (a >= 240) return true;
    // 100.64.0.0/10 CGNAT (often used internally too)
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }
  if (family === 6) {
    const lower = addr.toLowerCase();
    // Loopback ::1
    if (lower === '::1' || lower === '::') return true;
    // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateAddress(mapped[1]);
    // Parse first hextet
    const firstHex = lower.split(':')[0] || '0';
    const first = parseInt(firstHex, 16);
    // fe80::/10 link-local
    if ((first & 0xffc0) === 0xfe80) return true;
    // fc00::/7 unique local
    if ((first & 0xfe00) === 0xfc00) return true;
    // ff00::/8 multicast
    if ((first & 0xff00) === 0xff00) return true;
    // ::/128 unspecified handled above; ::ffff handled above
    return false;
  }
  // Not an IP at all → caller should not pass this to isPrivateAddress;
  // treat conservatively.
  return true;
}

function isForbiddenHost(domain: string): boolean {
  const d = domain.toLowerCase();
  if (FORBIDDEN_DOMAIN_EXACT.has(d)) return true;
  for (const suffix of FORBIDDEN_DOMAIN_SUFFIXES) {
    if (d === suffix.replace(/^\./, '') || d.endsWith(suffix)) return true;
  }
  return false;
}

async function assertPublicDomain(domain: string, logger: Logger): Promise<void> {
  if (isForbiddenHost(domain)) {
    throw new Error(`Refusing to fetch internal/reserved host: ${domain}`);
  }
  // Reject literal IP addresses passed as the "domain" — callers must use
  // hostnames, and we want to control resolution ourselves.
  if (net.isIP(domain)) {
    if (isPrivateAddress(domain)) {
      throw new Error(`Refusing to fetch private IP: ${domain}`);
    }
    return;
  }
  let addrs: { address: string; family: number }[] = [];
  try {
    addrs = await dns.promises.lookup(domain, { all: true });
  } catch (e: any) {
    throw new Error(`DNS lookup failed for ${domain}: ${e?.message || e}`);
  }
  if (!addrs.length) {
    throw new Error(`DNS lookup returned no addresses for ${domain}`);
  }
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new Error(`Refusing to fetch ${domain} — resolves to private/internal address ${a.address}`);
    }
  }
}

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
      // SSRF guard: refuse internal/private targets before issuing any fetch.
      await assertPublicDomain(domain, this.logger);

      // Fetch the page HTML from the domain. 5-second hard timeout.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      let response: Response;
      try {
        response = await fetch(`https://${domain}`, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrchardBot/1.0)' },
          // Do NOT follow redirects: a 3xx Location could rebind to an
          // internal host that would bypass our pre-resolution check.
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (response.status >= 300 && response.status < 400) {
        this.logger.warn(`Refusing to follow redirect from ${domain} (status ${response.status})`);
        this.memoryCache.set(domain, { url: null, ts: Date.now() });
        return null;
      }

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
      // Validate scheme and host BEFORE issuing the fetch — icon URLs from
      // parsed HTML can target arbitrary hosts and must be re-checked.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        return null;
      }
      try {
        await assertPublicDomain(parsed.hostname, this.logger);
      } catch (e: any) {
        this.logger.warn(`Refusing to fetch image from ${url}: ${e?.message || e}`);
        return null;
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);

      let res: Response;
      try {
        res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OrchardBot/1.0)' },
          // Don't follow redirects — a 3xx could rebind to internal space.
          redirect: 'manual',
        });
      } finally {
        clearTimeout(timeout);
      }

      if (res.status >= 300 && res.status < 400) return null;
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
