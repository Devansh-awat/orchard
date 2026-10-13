import {
  type BridgeArch,
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
  private pending: Promise<Partial<Record<BridgeArch, string>> | null> | null = null;

  private values: Partial<Record<BridgeArch, string>> | null = null;

  private failedAt = 0;

  constructor(
    private readonly fetcher: ChecksumFetch = (url, init) => fetch(url, init),
    private readonly version: string = SANDBOX_BRIDGE_CLI_VERSION
  ) {}

  async resolve(
    bridgeUrl: string,
    configured: string | null,
    arch: BridgeArch = 'amd64'
  ): Promise<string | null> {
    const pinned = (configured || '').trim().toLowerCase();
    if (pinned) return SHA256_RE.test(pinned) ? pinned : null;
    if (bridgeUrl !== defaultBridgeBinaryUrl(this.version, arch)) return null;
    if (this.values) return this.values[arch] ?? null;
    if (this.failedAt && Date.now() - this.failedAt < FAILURE_RETRY_MS) return null;
    if (!this.pending) {
      this.pending = this.fetchChecksums().finally(() => {
        this.pending = null;
      });
    }
    return (await this.pending)?.[arch] ?? null;
  }

  private async fetchChecksums(): Promise<Partial<Record<BridgeArch, string>> | null> {
    try {
      const res = await this.fetcher(bridgeChecksumsUrl(this.version), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`checksums.txt returned ${res.status}`);
      const text = (await res.text()).slice(0, MAX_CHECKSUMS_BYTES);
      const values: Partial<Record<BridgeArch, string>> = {};
      for (const arch of ['amd64', 'arm64'] as const) {
        const sha = checksumFor(text, bridgeArchiveName(this.version, arch));
        if (sha) values[arch] = sha;
      }
      if (!values.amd64) {
        throw new Error(`checksums.txt has no entry for ${bridgeArchiveName(this.version)}`);
      }
      this.values = values;
      this.failedAt = 0;
      return values;
    } catch {
      this.failedAt = Date.now();
      return null;
    }
  }
}
