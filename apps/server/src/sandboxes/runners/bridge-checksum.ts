import {
  SANDBOX_BRIDGE_CLI_VERSION,
  SHA256_RE,
  bridgeArchiveName,
  bridgeChecksumsUrl,
  checksumFor,
  defaultBridgeBinaryUrl
} from '../sandbox-bootstrap';

const FETCH_TIMEOUT_MS = 10_000;
const FAILURE_RETRY_MS = 5 * 60_000;
const MAX_CHECKSUMS_BYTES = 64 * 1024;

export type ChecksumFetch = (url: string, init: { signal: AbortSignal }) => Promise<Response>;

export class BridgeChecksumResolver {
  private pending: Promise<string | null> | null = null;

  private value: string | null = null;

  private failedAt = 0;

  constructor(
    private readonly fetcher: ChecksumFetch = (url, init) => fetch(url, init),
    private readonly version: string = SANDBOX_BRIDGE_CLI_VERSION
  ) {}

  async resolve(bridgeUrl: string, configured: string | null): Promise<string | null> {
    const pinned = (configured || '').trim().toLowerCase();
    if (pinned) return SHA256_RE.test(pinned) ? pinned : null;
    if (bridgeUrl !== defaultBridgeBinaryUrl(this.version)) return null;
    if (this.value) return this.value;
    if (this.failedAt && Date.now() - this.failedAt < FAILURE_RETRY_MS) return null;
    if (!this.pending) {
      this.pending = this.fetchChecksum().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async fetchChecksum(): Promise<string | null> {
    try {
      const res = await this.fetcher(bridgeChecksumsUrl(this.version), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`checksums.txt returned ${res.status}`);
      const text = (await res.text()).slice(0, MAX_CHECKSUMS_BYTES);
      const sha = checksumFor(text, bridgeArchiveName(this.version));
      if (!sha)
        throw new Error(`checksums.txt has no entry for ${bridgeArchiveName(this.version)}`);
      this.value = sha;
      this.failedAt = 0;
      return sha;
    } catch {
      this.failedAt = Date.now();
      return null;
    }
  }
}
