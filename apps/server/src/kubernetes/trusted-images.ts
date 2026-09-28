// Trusted images bypass the tenant sandbox runtime (gVisor/Kata) and run on
// the default containerd runtime (runc). Use this only for first-party infra
// images we ship and trust — never for anything that executes user code.
//
// Why bypass: sandbox runtimes pay real costs. gVisor's runsc reimplements
// syscalls in userspace and rejects some uid/cap transitions (e.g. Redis's
// entrypoint `setpriv` drop fails with EPERM). Kata boots a microVM per pod.
// Neither is justified for code we built and ship ourselves.
//
// Matching: patterns are matched against the image reference with the
// registry/digest stripped, leaving `repo[:tag]`. Two forms:
//   - `repo`           → matches any tag of that repo
//   - `repo:tag`       → matches that exact tag
// Glob `*` is supported in the tag position (e.g. `redis:7-*`).

export type TrustedImagePattern = string;

export const TRUSTED_IMAGES: TrustedImagePattern[] = [
  // Redis — used internally for caching/queues. Official image's entrypoint
  // does a root→redis uid drop that runsc rejects.
  'redis',
  'redis:*',
  'bitnami/redis',
  'bitnami/redis:*'
];

const DOCKER_HUB_HOSTS = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);

const parseRef = (image: string): { repo: string; tag: string; host: string | null } => {
  const noDigest = image.split('@')[0];
  const slashIdx = noDigest.indexOf('/');
  let remainder = noDigest;
  let host: string | null = null;
  if (slashIdx > 0) {
    const maybeHost = noDigest.slice(0, slashIdx);
    if (maybeHost.includes('.') || maybeHost.includes(':') || maybeHost === 'localhost') {
      host = maybeHost.toLowerCase();
      remainder = noDigest.slice(slashIdx + 1);
    }
  }
  const colonIdx = remainder.lastIndexOf(':');
  if (colonIdx === -1) return { repo: remainder, tag: 'latest', host };
  return { repo: remainder.slice(0, colonIdx), tag: remainder.slice(colonIdx + 1), host };
};

const globToRegex = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
};

const matchPattern = (pattern: TrustedImagePattern, image: string): boolean => {
  const { repo, tag, host } = parseRef(image);
  if (host !== null && !DOCKER_HUB_HOSTS.has(host)) return false;
  const colonIdx = pattern.indexOf(':');
  const patRepo = colonIdx === -1 ? pattern : pattern.slice(0, colonIdx);
  const patTag = colonIdx === -1 ? null : pattern.slice(colonIdx + 1);
  if (patRepo !== repo) return false;
  if (patTag === null) return true;
  return globToRegex(patTag).test(tag);
};

export const imageRepo = (image: string): string => parseRef(image).repo;

// Tags that a registry can move under you. A deployment pinned to one of these
// will not pick up a new push unless its pull policy is Always, which is the
// single most common "why is it still serving the old build" report.
const MUTABLE_TAGS = new Set([
  'latest',
  'main',
  'master',
  'stable',
  'edge',
  'dev',
  'develop',
  'nightly',
  'prod',
  'production',
  'release'
]);

export const isMutableImageTag = (image: string | null | undefined): boolean => {
  const raw = String(image ?? '').trim();
  if (!raw) return false;
  // A digest pins the exact bytes, so nothing can move under it.
  if (raw.includes('@sha256:')) return false;
  const { tag } = parseRef(raw);
  if (MUTABLE_TAGS.has(tag.toLowerCase())) return true;
  // A floating version like `17` or `1.2` tracks the newest patch under it.
  return /^v?\d+(\.\d+)?$/.test(tag);
};

export type ImagePullPolicyValue = 'Always' | 'IfNotPresent';

// What the pull policy should be when nobody has said otherwise. A tag that can
// move only behaves the way people expect under Always: otherwise the node
// reuses its cached layer and pushing over the tag silently changes nothing.
export const defaultPullPolicyForImage = (
  image: string | null | undefined
): ImagePullPolicyValue => (isMutableImageTag(image) ? 'Always' : 'IfNotPresent');

// `override` is the stored column: null means "derive", anything else is the
// user's explicit choice and wins.
export const resolvePullPolicy = (
  override: string | null | undefined,
  image: string | null | undefined
): ImagePullPolicyValue =>
  override === 'Always' || override === 'IfNotPresent'
    ? override
    : defaultPullPolicyForImage(image);

export const isTrustedImage = (image: string): boolean => {
  if (!image) return false;
  const extra = (process.env.TRUSTED_IMAGES_EXTRA || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const patterns = [...TRUSTED_IMAGES, ...extra];
  return patterns.some((p) => matchPattern(p, image));
};

// Security context for trusted images. We still forbid acquiring NEW privileges
// mid-process and apply the runtime's default seccomp profile, but we keep the
// default container capability set instead of dropping ALL. Images like Redis
// need CAP_SETUID/SETGID/CHOWN to do their root→service-user drop in the
// entrypoint; dropping ALL caps causes `setresuid: Operation not permitted`.
export const trustedSecurityContext = () => ({
  allowPrivilegeEscalation: false,
  seccompProfile: { type: 'RuntimeDefault' as const }
});

// Default hardened context for untrusted tenant code.
//
// We drop ALL capabilities, then add back the minimal set official images
// (postgres, nginx, mysql, redis, …) need for their entrypoint's
// root→service-user drop via gosu/su-exec/setpriv: SETUID/SETGID for the
// uid/gid transition itself, CHOWN/FOWNER/DAC_OVERRIDE to chown+chmod the
// data dir before dropping. These caps are enforced by gVisor's Sentry
// (userspace kernel), not the host kernel — granting them inside the
// sandbox confers no host privilege, and allowPrivilegeEscalation=false
// (no_new_privs) still blocks re-gaining privileges via setuid binaries
// or file capabilities after the drop.
export const hardenedSecurityContext = () => ({
  allowPrivilegeEscalation: false,
  capabilities: {
    drop: ['ALL'],
    add: ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SYS_CHROOT']
  },
  seccompProfile: { type: 'RuntimeDefault' as const }
});
