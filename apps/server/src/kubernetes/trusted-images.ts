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
  'bitnami/redis:*',
];

const parseRef = (image: string): { repo: string; tag: string } => {
  // Strip digest
  const noDigest = image.split('@')[0];
  // Strip registry host (anything before first `/` that contains `.` or `:`)
  const slashIdx = noDigest.indexOf('/');
  let remainder = noDigest;
  if (slashIdx > 0) {
    const maybeHost = noDigest.slice(0, slashIdx);
    if (maybeHost.includes('.') || maybeHost.includes(':') || maybeHost === 'localhost') {
      remainder = noDigest.slice(slashIdx + 1);
    }
  }
  const colonIdx = remainder.lastIndexOf(':');
  if (colonIdx === -1) return { repo: remainder, tag: 'latest' };
  return { repo: remainder.slice(0, colonIdx), tag: remainder.slice(colonIdx + 1) };
};

const globToRegex = (glob: string): RegExp => {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
};

const matchPattern = (pattern: TrustedImagePattern, image: string): boolean => {
  const { repo, tag } = parseRef(image);
  const colonIdx = pattern.indexOf(':');
  const patRepo = colonIdx === -1 ? pattern : pattern.slice(0, colonIdx);
  const patTag = colonIdx === -1 ? null : pattern.slice(colonIdx + 1);
  if (patRepo !== repo) return false;
  if (patTag === null) return true;
  return globToRegex(patTag).test(tag);
};

export const imageRepo = (image: string): string => parseRef(image).repo;

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
  seccompProfile: { type: 'RuntimeDefault' as const },
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
    add: ['SETUID', 'SETGID', 'CHOWN', 'FOWNER', 'DAC_OVERRIDE', 'SYS_CHROOT'],
  },
  seccompProfile: { type: 'RuntimeDefault' as const },
});
