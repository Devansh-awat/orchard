import { isCollapsedAddress, parseTrustProxy } from '../auth/client-ip';
import { resolveBuildPosture } from '../docker/build-posture';
import { registryPolicyMode } from '../kubernetes/registry-image-policy';
import { nodePortExposureEnabled } from '../quotas/instance-limits';
import { check, type DoctorCheck, type Fact } from './doctor.types';

export interface DaemonSetFact {
  name: string;
  namespace: string;
  desired: number;
  ready: number;
}

export interface NodeFact {
  name: string;
  kubelet: string;
}

export interface NamespaceFact {
  name: string;
  labels: Record<string, string>;
}

export interface AdmissionBindingFact {
  name: string;
  policyName: string;
  actions: string[];
}

export interface AdmissionFacts {
  policies: string[];
  bindings: AdmissionBindingFact[];
}

export interface IssuerFact {
  exists: boolean;
  ready: boolean | null;
}

export interface SettingsFact {
  signupMode: string;
  customDomainVerification: boolean;
}

export interface ProbeFact {
  ok: boolean;
  detail: string;
}

export interface RequestFact {
  socketAddress: string | null;
  forwardedFor: string | null;
  resolved: string;
}

export interface DoctorInputs {
  env: Record<string, string | undefined>;
  request: RequestFact | null;
  apiGroups: Fact<string[]>;
  daemonSets: Fact<DaemonSetFact[]>;
  nodes: Fact<NodeFact[]>;
  namespaces: Fact<NamespaceFact[]>;
  denyPolicies: Fact<string[]>;
  quotas: Fact<Record<string, string[]>>;
  tenantRuntimeClass: Fact<boolean> | null;
  builderRuntimeClass: Fact<boolean> | null;
  admission: Fact<AdmissionFacts>;
  priorityClass: Fact<boolean>;
  issuer: Fact<IssuerFact>;
  settings: Fact<SettingsFact>;
  metrics: Fact<ProbeFact>;
  logs: Fact<ProbeFact>;
}

export const DENY_POLICY_NAME = 'default-deny-all';
export const ORG_QUOTA_NAME = 'orchard-org-quota';
export const ABUSE_QUOTA_NAME = 'orchard-abuse-quota';
export const PRIORITY_CLASS_NAME = 'orchard-platform';
export const IMAGE_POLICY_NAME = 'orchard-tenant-images';

export const EXPECTED_POLICIES = [
  'orchard-tenant-pods',
  'orchard-tenant-pods-hardening',
  'orchard-tenant-services',
  'orchard-tenant-endpointslices',
  'orchard-tenant-ingresses',
  'orchard-tenant-pvcs',
  'orchard-tenant-networkpolicies',
  'orchard-tenant-rolebindings',
  'orchard-tenant-cnpg-clusters',
  'orchard-managed-namespaces'
];

const ENFORCING_CNIS: { name: string; daemonSets: RegExp; group?: string }[] = [
  { name: 'Cilium', daemonSets: /^cilium$/, group: 'cilium.io' },
  { name: 'Calico', daemonSets: /^calico-node$/, group: 'crd.projectcalico.org' },
  { name: 'Antrea', daemonSets: /^antrea-agent$/, group: 'crd.antrea.io' },
  { name: 'kube-router', daemonSets: /^kube-router$/ },
  { name: 'Weave Net', daemonSets: /^weave-net$/ },
  { name: 'Canal', daemonSets: /^canal$/ },
  { name: 'Azure network policy manager', daemonSets: /^azure-npm$/ }
];

const NON_ENFORCING_CNIS = /^(kube-flannel-ds|flannel|kube-flannel)/;

const CNI_FIX =
  'Install a CNI that enforces NetworkPolicy (Cilium or Calico), or enable your cloud provider network policy add-on. Then run the isolation self-test to confirm enforcement.';

const unreadable = (id: string, title: string, error: string, fix: string): DoctorCheck =>
  check(id, title, 'unknown', `Could not read it: ${error}`, fix);

function listNames(names: string[], max = 5): string {
  const shown = names.slice(0, max).join(', ');
  return names.length > max ? `${shown} and ${names.length - max} more` : shown;
}

export function cniCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'cni-enforcement';
  const title = 'NetworkPolicy-capable CNI present';
  if (!inputs.apiGroups.ok && !inputs.daemonSets.ok) {
    return unreadable(id, title, inputs.apiGroups.error, CNI_FIX);
  }
  const groups = inputs.apiGroups.ok ? inputs.apiGroups.value : [];
  const daemonSets = inputs.daemonSets.ok ? inputs.daemonSets.value : [];
  const found: string[] = [];
  const unready: string[] = [];
  for (const cni of ENFORCING_CNIS) {
    const sets = daemonSets.filter((d) => cni.daemonSets.test(d.name));
    const hasGroup = cni.group ? groups.includes(cni.group) : false;
    if (sets.length === 0 && !hasGroup) continue;
    found.push(cni.name);
    for (const set of sets) {
      if (set.ready < set.desired) {
        unready.push(`${set.namespace}/${set.name} ${set.ready}/${set.desired} ready`);
      }
    }
  }
  if (found.length > 0) {
    if (unready.length > 0) {
      return check(
        id,
        title,
        'warn',
        `${found.join(', ')} detected, but not every node runs it: ${unready.join('; ')}. Nodes without the agent do not enforce policy.`,
        'Get the CNI daemonset healthy on every node (kubectl -n kube-system get ds).'
      );
    }
    return check(
      id,
      title,
      'pass',
      `${found.join(', ')} detected (CRDs or daemonset). Detection shows the CNI is installed, not that it enforces; the self-test proves enforcement.`
    );
  }
  const nodes = inputs.nodes.ok ? inputs.nodes.value : [];
  if (nodes.some((n) => /k3s|rke2/i.test(n.kubelet))) {
    return check(
      id,
      title,
      'unknown',
      'k3s or RKE2 nodes: the distribution ships an embedded NetworkPolicy controller that is not visible as a daemonset, and it can be disabled. Cannot tell passively.',
      'Run the isolation self-test. Make sure k3s was not started with --disable-network-policy.'
    );
  }
  if (daemonSets.some((d) => NON_ENFORCING_CNIS.test(d.name))) {
    return check(
      id,
      title,
      'warn',
      'Only Flannel was found, which does not enforce NetworkPolicy by itself. Every tenant policy is inert unless something else enforces it.',
      CNI_FIX
    );
  }
  return check(
    id,
    title,
    'unknown',
    'No known policy-enforcing CNI was detected. Managed CNIs (EKS, GKE Dataplane V2, AKS) do not appear as daemonsets here.',
    'Run the isolation self-test. If it reports the tenant namespace can reach platform targets, ' +
      CNI_FIX
  );
}

export function defaultDenyCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'default-deny-coverage';
  const title = 'Default-deny policy in every managed namespace';
  const fix =
    'Restart the server (it re-applies the policy to every managed namespace on boot), or call the namespace reconcile. Investigate namespaces that keep failing.';
  if (!inputs.namespaces.ok) return unreadable(id, title, inputs.namespaces.error, fix);
  if (!inputs.denyPolicies.ok) return unreadable(id, title, inputs.denyPolicies.error, fix);
  const managed = inputs.namespaces.value.map((n) => n.name);
  const have = new Set(inputs.denyPolicies.value);
  const missing = managed.filter((name) => !have.has(name));
  if (managed.length === 0) {
    return check(id, title, 'pass', 'No managed tenant namespaces exist yet.');
  }
  if (missing.length > 0) {
    return check(
      id,
      title,
      'fail',
      `${missing.length} of ${managed.length} managed namespaces have no ${DENY_POLICY_NAME} NetworkPolicy and accept and send any traffic: ${listNames(missing)}.`,
      fix
    );
  }
  return check(
    id,
    title,
    'pass',
    `All ${managed.length} managed namespaces carry ${DENY_POLICY_NAME}.`
  );
}

export function tenantRuntimeCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'tenant-runtime-class';
  const title = 'Tenant sandbox RuntimeClass';
  const configured = (inputs.env.TENANT_RUNTIME_CLASS || '').trim();
  if (!configured) {
    return check(
      id,
      title,
      'warn',
      'TENANT_RUNTIME_CLASS is not set. Tenant pods run on the node runtime and share the host kernel with each other and with the platform.',
      'Set tenantSandbox.enabled=true in the chart (gVisor) on nodes that provide the runtime, or set TENANT_RUNTIME_CLASS to your sandbox RuntimeClass.'
    );
  }
  const fix = `Create RuntimeClass "${configured}" and its node runtime handler, or unset TENANT_RUNTIME_CLASS. Pods that name a missing RuntimeClass never schedule.`;
  if (!inputs.tenantRuntimeClass) return check(id, title, 'unknown', 'Not evaluated.', fix);
  if (!inputs.tenantRuntimeClass.ok) {
    return unreadable(id, title, inputs.tenantRuntimeClass.error, fix);
  }
  if (!inputs.tenantRuntimeClass.value) {
    return check(
      id,
      title,
      'fail',
      `TENANT_RUNTIME_CLASS is "${configured}" but no such RuntimeClass exists.`,
      fix
    );
  }
  return check(id, title, 'pass', `Tenant pods use RuntimeClass "${configured}", and it exists.`);
}

export function builderPostureCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'builder-posture';
  const title = 'Build isolation posture';
  const posture = resolveBuildPosture(inputs.env);
  if (posture === 'privileged-host') {
    return check(
      id,
      title,
      'fail',
      'Builds run in a privileged BuildKit container on the node runtime (builders.allowPrivilegedOnHost=true). A malicious Dockerfile RUN step is root on the node.',
      'Remove builders.allowPrivilegedOnHost, or enable builderSandbox (Kata) for VM-level separation.'
    );
  }
  if (posture === 'rootless') {
    return check(
      id,
      title,
      'warn',
      'Builds run in rootless BuildKit (uid 1000, user namespaces, seccomp and AppArmor Unconfined) on the shared node kernel.',
      'Enable builderSandbox (Kata with KVM) so builds run inside a VM.'
    );
  }
  const runtime = (inputs.env.BUILDER_RUNTIME_CLASS || '').trim();
  const fix = `Create RuntimeClass "${runtime}" on nodes with KVM, or unset BUILDER_RUNTIME_CLASS.`;
  if (!inputs.builderRuntimeClass) return check(id, title, 'unknown', 'Not evaluated.', fix);
  if (!inputs.builderRuntimeClass.ok)
    return unreadable(id, title, inputs.builderRuntimeClass.error, fix);
  if (!inputs.builderRuntimeClass.value) {
    return check(
      id,
      title,
      'fail',
      `BUILDER_RUNTIME_CLASS is "${runtime}" but no such RuntimeClass exists, so builds cannot start.`,
      fix
    );
  }
  return check(id, title, 'pass', `Builds run privileged inside the "${runtime}" VM sandbox.`);
}

export function podSecurityCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'pod-security-labels';
  const title = 'Pod Security Admission labels on managed namespaces';
  const fix =
    'Label the namespaces pod-security.kubernetes.io/enforce=baseline (Orchard sets this on creation). kubectl label ns <name> pod-security.kubernetes.io/enforce=baseline --overwrite';
  if (!inputs.namespaces.ok) return unreadable(id, title, inputs.namespaces.error, fix);
  const namespaces = inputs.namespaces.value;
  const weak = namespaces.filter((ns) => {
    const level = ns.labels['pod-security.kubernetes.io/enforce'];
    return level !== 'baseline' && level !== 'restricted';
  });
  if (namespaces.length === 0) {
    return check(id, title, 'pass', 'No managed tenant namespaces exist yet.');
  }
  if (weak.length > 0) {
    return check(
      id,
      title,
      'fail',
      `${weak.length} of ${namespaces.length} managed namespaces do not enforce Pod Security baseline: ${listNames(weak.map((n) => n.name))}.`,
      fix
    );
  }
  return check(
    id,
    title,
    'pass',
    `All ${namespaces.length} managed namespaces enforce baseline or restricted.`
  );
}

export function admissionCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'admission-policies';
  const title = 'Admission policies installed and enforcing';
  const fix =
    'Install the chart with admissionPolicies.enabled=true on Kubernetes 1.30 or later. After a week without unexpected warnings set admissionPolicies.validationActions=[Deny] and hardeningActions=[Deny].';
  if (!inputs.admission.ok) return unreadable(id, title, inputs.admission.error, fix);
  const { policies, bindings } = inputs.admission.value;
  const installed = EXPECTED_POLICIES.filter((name) => policies.includes(name));
  if (installed.length === 0) {
    return check(
      id,
      title,
      'warn',
      'None of the Orchard ValidatingAdmissionPolicies are installed. Object shapes Orchard never creates are not refused at the API.',
      fix
    );
  }
  const missingPolicies = EXPECTED_POLICIES.filter((name) => !policies.includes(name));
  const unbound = installed.filter((name) => !bindings.some((b) => b.policyName === name));
  if (missingPolicies.length > 0 || unbound.length > 0) {
    return check(
      id,
      title,
      'fail',
      `Partially installed. Missing: ${missingPolicies.join(', ') || 'none'}. Without a binding: ${unbound.join(', ') || 'none'}.`,
      fix
    );
  }
  const soft = EXPECTED_POLICIES.filter((name) => {
    const own = bindings.filter((b) => b.policyName === name);
    return !own.every((b) => b.actions.includes('Deny'));
  });
  if (soft.length > 0) {
    return check(
      id,
      title,
      'warn',
      `${soft.length} of ${EXPECTED_POLICIES.length} policies only warn or audit and do not refuse: ${listNames(soft)}.`,
      fix
    );
  }
  return check(
    id,
    title,
    'pass',
    `All ${EXPECTED_POLICIES.length} policies are installed with Deny.`
  );
}

export function redisCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'redis-auth';
  const title = 'Redis requires authentication';
  const url = (inputs.env.REDIS_URL || '').trim();
  const fix =
    'Give Redis a password and include it in REDIS_URL (redis://:password@host:6379). The chart does this when redis.auth is enabled.';
  if (!url) {
    return check(
      id,
      title,
      'warn',
      'REDIS_URL is not set. Rate limits, sessions state and event fan-out are per pod, so limits multiply by replica count.',
      'Set REDIS_URL (the chart provisions Redis).'
    );
  }
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    parsed = null;
  }
  if (!parsed)
    return check(id, title, 'warn', 'REDIS_URL is set but does not parse as a URL.', fix);
  if (parsed.password || (inputs.env.REDIS_PASSWORD || '').trim()) {
    return check(id, title, 'pass', `Redis at ${parsed.hostname} is configured with a password.`);
  }
  return check(
    id,
    title,
    'warn',
    `Redis at ${parsed.hostname} is configured without a password. Anything that reaches it can read sessions, throttle state and cached data. Network policy is the only protection.`,
    fix
  );
}

export function secretsKeyCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'secrets-encryption-key';
  const title = 'Secrets encryption key';
  const fix =
    'Set SECRETS_ENCRYPTION_KEY to a random string of at least 32 characters (openssl rand -hex 32) in server.env and restart. A boot backfill encrypts existing plaintext rows.';
  const key = (inputs.env.SECRETS_ENCRYPTION_KEY || '').trim();
  const fallback = (inputs.env.SSO_ENCRYPTION_KEY || '').trim();
  if (!key && !fallback) {
    return check(
      id,
      title,
      'fail',
      'No SECRETS_ENCRYPTION_KEY is set. Secret environment variables, job secrets and database passwords are stored in plaintext.',
      fix
    );
  }
  if (!key) {
    return check(
      id,
      title,
      'warn',
      'Only SSO_ENCRYPTION_KEY is set and is used as the secrets key. Rotating one rotates both.',
      fix
    );
  }
  if (key.length < 32) {
    return check(
      id,
      title,
      'warn',
      `The key is ${key.length} characters long; use at least 32.`,
      fix
    );
  }
  return check(id, title, 'pass', 'A secrets encryption key of adequate length is set.');
}

const EXAMPLE_SECRETS = /^(changeme|change-me|secret|password|example|test|dev|your[-_ ])/i;

function variety(value: string): number {
  return new Set(value).size;
}

export function jwtSecretCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'jwt-secret-strength';
  const title = 'JWT secret strength';
  const fix = 'Set JWT_SECRET to openssl rand -hex 32 or longer. Rotating it signs every user out.';
  const secret = inputs.env.JWT_SECRET || '';
  if (!secret) {
    return check(id, title, 'fail', 'JWT_SECRET is not set.', fix);
  }
  const problems: string[] = [];
  if (secret.length < 32) problems.push(`only ${secret.length} characters`);
  if (EXAMPLE_SECRETS.test(secret)) problems.push('looks like an example value');
  if (variety(secret) < 10) problems.push('low character variety');
  const reused = [inputs.env.SECRETS_ENCRYPTION_KEY, inputs.env.SSO_ENCRYPTION_KEY].some(
    (other) => other && other === secret
  );
  if (problems.length > 0) {
    return check(id, title, 'fail', `JWT_SECRET is weak: ${problems.join(', ')}.`, fix);
  }
  if (reused) {
    return check(
      id,
      title,
      'warn',
      'JWT_SECRET is the same value as an encryption key. A leak of one is a leak of both.',
      'Use a distinct random value for each.'
    );
  }
  return check(
    id,
    title,
    'pass',
    `JWT_SECRET is ${secret.length} characters with adequate variety.`
  );
}

export function clientIpCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'client-ip-trust';
  const title = 'Client IP and proxy trust';
  const fix =
    'Set TRUST_PROXY to the number of proxies in front of the server (for example 1) or a comma-separated list of their CIDRs. Set CLIENT_IP_HEADER with CLIENT_IP_HEADER_FROM for a CDN header.';
  const raw = (inputs.env.TRUST_PROXY || '').trim();
  const trust = parseTrustProxy(raw);
  const configured = trust.hops > 0 || trust.ranges.length > 0;
  if (raw && raw.toLowerCase() !== 'false' && !configured) {
    return check(
      id,
      title,
      'warn',
      `TRUST_PROXY="${raw.slice(0, 40)}" is neither a hop count nor a list of CIDRs, so no proxy is trusted.`,
      fix
    );
  }
  const req = inputs.request;
  if (!req || !req.socketAddress) {
    return check(id, title, 'unknown', 'No request to inspect.', fix);
  }
  const peerPrivate = isCollapsedAddress(req.socketAddress);
  const resolvedPrivate = isCollapsedAddress(req.resolved);
  if (peerPrivate && resolvedPrivate && req.forwardedFor) {
    return check(
      id,
      title,
      'warn',
      `This request arrived from private peer ${req.socketAddress} carrying X-Forwarded-For, but the server resolved the client as ${req.resolved}. Behind a proxy every client shares one address, so per-IP rate limits and abuse controls treat all users as one.`,
      fix
    );
  }
  if (!peerPrivate && req.forwardedFor && !configured) {
    return check(
      id,
      title,
      'pass',
      `This request arrived from public peer ${req.socketAddress}. X-Forwarded-For is ignored because no proxy is trusted, which is correct for a directly exposed server.`
    );
  }
  if (peerPrivate && !req.forwardedFor && !configured) {
    return check(
      id,
      title,
      'unknown',
      `This request came from private peer ${req.socketAddress} with no X-Forwarded-For. Could be a port-forward or an in-cluster call; cannot judge.`,
      'Run the check again from the dashboard through your normal ingress.'
    );
  }
  return check(id, title, 'pass', `Client IP resolved to ${req.resolved} for this request.`);
}

export function signupCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'signup-and-domain-verification';
  const title = 'Signup mode and custom-domain verification';
  const fix =
    'Turn on custom-domain verification in Admin, Instance settings (or CUSTOM_DOMAIN_VERIFICATION=true), or set SIGNUP_MODE=invite_only.';
  if (!inputs.settings.ok) return unreadable(id, title, inputs.settings.error, fix);
  const { signupMode, customDomainVerification } = inputs.settings.value;
  const facts = `SIGNUP_MODE is ${signupMode}; custom-domain verification is ${customDomainVerification ? 'required' : 'off'}.`;
  if (signupMode === 'open' && !customDomainVerification) {
    return check(
      id,
      title,
      'fail',
      `${facts} Anyone can sign up and claim any hostname, including hostnames of other organizations' domains.`,
      fix
    );
  }
  if (signupMode === 'open') {
    return check(
      id,
      title,
      'warn',
      `${facts} Open signup means untrusted tenants are expected; isolation is the only barrier.`,
      'Confirm the self-test passes, and consider invite_only.'
    );
  }
  return check(id, title, 'pass', facts);
}

export function registryPolicyCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'registry-image-policy';
  const title = 'Registry image ownership policy';
  const setting = registryPolicyMode(inputs.env.REGISTRY_IMAGE_POLICY);
  const fix =
    'Set REGISTRY_IMAGE_POLICY=enforce (or leave it unset for auto) and make sure DOCKER_REGISTRY_PULL and DOCKER_REGISTRY_PUSH are set.';
  const hosts = [inputs.env.DOCKER_REGISTRY_PULL, inputs.env.DOCKER_REGISTRY_PUSH].filter(Boolean);
  if (setting === 'off') {
    return check(
      id,
      title,
      'fail',
      "REGISTRY_IMAGE_POLICY=off. A pod can name another project's image repository on the platform registry.",
      fix
    );
  }
  if (hosts.length === 0) {
    return check(
      id,
      title,
      'warn',
      `REGISTRY_IMAGE_POLICY is ${setting}, but no platform registry host is configured, so the policy is not installed.`,
      fix
    );
  }
  if (!inputs.admission.ok) return unreadable(id, title, inputs.admission.error, fix);
  const bindings = inputs.admission.value.bindings.filter(
    (b) => b.policyName === IMAGE_POLICY_NAME
  );
  if (bindings.length === 0) {
    return check(
      id,
      title,
      'warn',
      `REGISTRY_IMAGE_POLICY is ${setting}, but the ${IMAGE_POLICY_NAME} policy is not installed yet.`,
      'Wait for the next reconcile (five minutes) or restart the server.'
    );
  }
  const deny = bindings.every((b) => b.actions.includes('Deny'));
  if (!deny) {
    return check(
      id,
      title,
      'warn',
      `Setting is ${setting}, effective action is warn and audit only. In auto mode the server falls back to warn when an existing image would break.`,
      'Fix the images the server logs as blockers, or set REGISTRY_IMAGE_POLICY=enforce.'
    );
  }
  return check(
    id,
    title,
    'pass',
    `Setting is ${setting}; the policy refuses foreign repositories (Deny).`
  );
}

export function nodePortCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'nodeport-exposure';
  const title = 'Tenant NodePort exposure';
  if (nodePortExposureEnabled(inputs.env)) {
    return check(
      id,
      title,
      'warn',
      'Tenants can publish TCP ports on node addresses. Nothing inside the cluster stops a published port from being reachable on every node.',
      'Turn off raw node ports under Admin -> Limits (or set tenant.nodePortExposure=false) unless you need them, and firewall node ports (30000-32767 and 10250, 22, 6443, 50000) at the cloud or host.'
    );
  }
  return check(id, title, 'pass', 'Tenant NodePort exposure is disabled.');
}

export function hostnameStyleCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'hostname-style';
  const title = 'Generated hostname style';
  const readable = (inputs.env.HOSTNAME_STYLE || '').trim().toLowerCase() === 'readable';
  if (readable) {
    return check(
      id,
      title,
      'warn',
      'HOSTNAME_STYLE=readable puts organization and project names in public hostnames. Anyone watching certificate transparency logs can enumerate customers.',
      'Unset HOSTNAME_STYLE (opaque is the default) unless readable names are wanted.'
    );
  }
  return check(id, title, 'pass', 'Generated hostnames are opaque.');
}

export function quotaCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'namespace-quotas';
  const title = 'ResourceQuota in every managed namespace';
  const fix =
    'Restart the server (it re-applies the abuse quota on boot) and set organization CPU and memory caps so ' +
    ORG_QUOTA_NAME +
    ' is created.';
  if (!inputs.namespaces.ok) return unreadable(id, title, inputs.namespaces.error, fix);
  if (!inputs.quotas.ok) return unreadable(id, title, inputs.quotas.error, fix);
  const namespaces = inputs.namespaces.value.map((n) => n.name);
  if (namespaces.length === 0) {
    return check(id, title, 'pass', 'No managed tenant namespaces exist yet.');
  }
  const quotas = inputs.quotas.value;
  const none = namespaces.filter((name) => (quotas[name] ?? []).length === 0);
  const noAbuse = namespaces.filter((name) => !(quotas[name] ?? []).includes(ABUSE_QUOTA_NAME));
  const noOrg = namespaces.filter((name) => !(quotas[name] ?? []).includes(ORG_QUOTA_NAME));
  if (none.length > 0) {
    return check(
      id,
      title,
      'fail',
      `${none.length} of ${namespaces.length} managed namespaces have no ResourceQuota at all: ${listNames(none)}.`,
      fix
    );
  }
  if (noAbuse.length > 0 || noOrg.length > 0) {
    return check(
      id,
      title,
      'warn',
      `${noAbuse.length} namespaces lack ${ABUSE_QUOTA_NAME} (load balancer, node port and ephemeral storage caps); ${noOrg.length} lack ${ORG_QUOTA_NAME} (CPU, memory, pods).`,
      fix
    );
  }
  return check(id, title, 'pass', `All ${namespaces.length} managed namespaces carry both quotas.`);
}

export function priorityClassCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'priority-class';
  const title = 'Platform PriorityClass';
  const fix = 'Set priorityClasses.enabled=true in the chart.';
  if (!inputs.priorityClass.ok) return unreadable(id, title, inputs.priorityClass.error, fix);
  if (!inputs.priorityClass.value) {
    return check(
      id,
      title,
      'warn',
      `PriorityClass ${PRIORITY_CLASS_NAME} does not exist. Under node pressure tenant pods can starve or evict platform pods.`,
      fix
    );
  }
  return check(id, title, 'pass', `PriorityClass ${PRIORITY_CLASS_NAME} exists.`);
}

export function certIssuerCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'cert-issuer';
  const title = 'Certificate issuer';
  const name = (inputs.env.CERT_CLUSTER_ISSUER || '').trim() || 'letsencrypt-prod';
  const fix = `Create ClusterIssuer "${name}" (cert-manager), or set CERT_CLUSTER_ISSUER to an existing one.`;
  if (!inputs.issuer.ok) return unreadable(id, title, inputs.issuer.error, fix);
  if (!inputs.issuer.value.exists) {
    return check(
      id,
      title,
      'fail',
      `ClusterIssuer "${name}" does not exist, so tenant ingresses never get certificates.`,
      fix
    );
  }
  if (inputs.issuer.value.ready === false) {
    return check(
      id,
      title,
      'fail',
      `ClusterIssuer "${name}" exists but is not Ready.`,
      'kubectl describe clusterissuer ' + name
    );
  }
  return check(
    id,
    title,
    'pass',
    `ClusterIssuer "${name}" exists${inputs.issuer.value.ready ? ' and is Ready' : ''}.`
  );
}

export function backupProxyCheck(inputs: DoctorInputs): DoctorCheck {
  const id = 'backup-proxy-buckets';
  const title = 'Backup proxy bucket allow-list';
  const enabled = inputs.env.BACKUP_PROXY_ENABLED === 'true';
  const fix =
    'Enable r2Proxy and list only the buckets you intend in r2Proxy.allowedBuckets (ALLOWED_BUCKETS in the r2-proxy-upstream Secret).';
  if (!enabled) {
    return check(
      id,
      title,
      'warn',
      'BACKUP_PROXY_ENABLED is not true. Database backups and the build cache use instance-wide object-store credentials rather than per-tenant scoped keys.',
      fix
    );
  }
  return check(
    id,
    title,
    'unknown',
    'The proxy is enabled. Its allow-list is in the r2-proxy-upstream Secret, which the server cannot and should not read, so the list cannot be verified here.',
    'Read ALLOWED_BUCKETS from the Secret yourself and confirm it names only intended buckets. The proxy refuses to start with none.'
  );
}

function probeCheck(
  id: string,
  title: string,
  fact: Fact<ProbeFact>,
  fix: string,
  what: string
): DoctorCheck {
  if (!fact.ok) return unreadable(id, title, fact.error, fix);
  if (!fact.value.ok)
    return check(id, title, 'warn', `${what} did not answer: ${fact.value.detail}`, fix);
  return check(id, title, 'pass', `${what} answered: ${fact.value.detail}`);
}

export function metricsCheck(inputs: DoctorInputs): DoctorCheck {
  return probeCheck(
    'metrics-stack',
    'Metrics stack reachable',
    inputs.metrics,
    'Check the VictoriaMetrics deployment in the orchard-metrics namespace and VICTORIAMETRICS_URL.',
    'VictoriaMetrics'
  );
}

export function logsCheck(inputs: DoctorInputs): DoctorCheck {
  return probeCheck(
    'logging-stack',
    'Logging stack reachable',
    inputs.logs,
    'Check the VictoriaLogs deployment and VICTORIALOGS_URL.',
    'VictoriaLogs'
  );
}

const EVALUATORS: [string, (inputs: DoctorInputs) => DoctorCheck][] = [
  ['cni-enforcement', cniCheck],
  ['default-deny-coverage', defaultDenyCheck],
  ['tenant-runtime-class', tenantRuntimeCheck],
  ['builder-posture', builderPostureCheck],
  ['pod-security-labels', podSecurityCheck],
  ['admission-policies', admissionCheck],
  ['redis-auth', redisCheck],
  ['secrets-encryption-key', secretsKeyCheck],
  ['jwt-secret-strength', jwtSecretCheck],
  ['client-ip-trust', clientIpCheck],
  ['signup-and-domain-verification', signupCheck],
  ['registry-image-policy', registryPolicyCheck],
  ['nodeport-exposure', nodePortCheck],
  ['hostname-style', hostnameStyleCheck],
  ['namespace-quotas', quotaCheck],
  ['priority-class', priorityClassCheck],
  ['cert-issuer', certIssuerCheck],
  ['backup-proxy-buckets', backupProxyCheck],
  ['metrics-stack', metricsCheck],
  ['logging-stack', logsCheck]
];

export const CHECK_IDS = EVALUATORS.map(([id]) => id);

export function evaluateAll(inputs: DoctorInputs): DoctorCheck[] {
  return EVALUATORS.map(([id, run]) => {
    try {
      return run(inputs);
    } catch (error) {
      return check(
        id,
        id,
        'unknown',
        `The check itself failed: ${String((error as Error)?.message ?? error).slice(0, 200)}`
      );
    }
  });
}
