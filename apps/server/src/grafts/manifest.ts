import { z } from 'zod';
import { isValidVersion } from './semver';

export const GRAFT_CAPABILITIES = [
  'db',
  'users.read',
  'projects.read',
  'projects.write',
  'kube.read',
  'kube.apply',
  'kube.informers',
  'kube.exec',
  'http.upgrade',
  'http.hostRouting',
  'github',
  'notifications',
  'audit',
  'events',
  'secrets',
  'settings',
  'rateLimit',
  'flags',
  'metrics',
  'mcp'
] as const;

export type GraftCapability = (typeof GRAFT_CAPABILITIES)[number];

export const RESERVED_GRAFT_IDS = new Set([
  'admin',
  'api',
  'apiv1',
  'app',
  'assets',
  'auth',
  'core',
  'grafts',
  'graft',
  'orchard',
  'static',
  'status',
  'user',
  'users',
  'oauth',
  'sso',
  'setup',
  'invite',
  'share',
  'dev',
  'mcp',
  'cli'
]);

const graftId = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]{1,47}$/,
    'must be 2-48 chars of lowercase letters, digits and dashes, starting with a letter'
  )
  .refine((id) => !RESERVED_GRAFT_IDS.has(id), 'is reserved by Orchard');

const version = z.string().refine(isValidVersion, 'must be a semver version like 1.2.3');

const pathSegment = z
  .string()
  .regex(/^[a-z0-9][a-z0-9/_.-]*$/i, 'must be a relative path without a leading slash')
  .refine((p) => !p.split('/').includes('..'), 'must not contain ..');

const settingField = z.object({
  key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
  type: z.enum(['string', 'text', 'number', 'boolean', 'select', 'secret']),
  label: z.string(),
  help: z.string().optional(),
  scope: z.enum(['instance', 'org', 'user']).default('instance'),
  env: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]*$/)
    .optional(),
  options: z.array(z.string()).optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  public: z.boolean().default(false)
});

const settingsSection = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  title: z.string(),
  description: z.string().optional(),
  storageKey: z
    .string()
    .regex(/^[a-z][a-z0-9_:-]*$/)
    .optional(),
  required: z.array(z.string()).default([]),
  fields: z.array(settingField)
});

const screen = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  path: z.string().regex(/^\/[^\s]*$/, 'must start with /'),
  layout: z.enum(['shell', 'fullscreen']).default('shell'),
  title: z.string().optional(),
  og: z
    .object({ title: z.string(), description: z.string().optional(), image: z.string().optional() })
    .optional()
});

const permission = z.object({
  label: z.string(),
  description: z.string().optional(),
  defaultGrants: z
    .array(
      z.enum([
        'org:owner',
        'org:admin',
        'org:member',
        'project:admin',
        'project:member',
        'project:viewer'
      ])
    )
    .default([])
});

const kubeVerb = z.object({
  group: z.string().default(''),
  resource: z.string(),
  verb: z.string(),
  namespace: z.string().optional()
});

export const graftManifestSchema = z
  .object({
    $schema: z.string().optional(),
    id: graftId,
    name: z.string().min(1).max(64),
    version,
    publisher: z.string().min(1).max(64),
    description: z.string().max(500).optional(),
    homepage: z.string().url().optional(),
    icon: z.string().optional(),
    engines: z.object({ platform: z.string(), sdk: z.string() }),
    uses: z.record(z.string(), z.number().int().positive()).default({}),
    requires: z
      .object({
        grafts: z.record(graftId, z.string()).default({}),
        kubernetes: z
          .object({ crds: z.array(z.string()).default([]), verbs: z.array(kubeVerb).default([]) })
          .default({})
      })
      .default({}),
    runtime: z.literal('native').default('native'),
    entries: z
      .object({
        server: pathSegment.optional(),
        mcp: pathSegment.optional(),
        ui: pathSegment.optional()
      })
      .default({}),
    capabilities: z.array(z.enum(GRAFT_CAPABILITIES)).default([]),
    claims: z
      .object({
        apiAliases: z.array(pathSegment).default([]),
        uiAliases: z.array(pathSegment).default([]),
        wsAliases: z.array(pathSegment).default([]),
        hostRouting: z.array(z.string()).default([]),
        notificationEvents: z.array(z.string()).default([]),
        notificationCategories: z.array(z.string()).default([]),
        configSections: z.array(z.string()).default([]),
        settingKeys: z.array(z.string()).default([]),
        rateLimitBuckets: z.array(z.string()).default([]),
        mcpTools: z.array(z.string()).default([]),
        sseEvents: z.array(z.string()).default([]),
        auditActions: z.array(z.string()).default([]),
        applyOps: z.array(z.string()).default([]),
        deviceNames: z.array(z.string()).default([]),
        mirrorShards: z.array(z.string()).default([])
      })
      .default({}),
    database: z
      .object({
        coreReads: z.record(z.string(), z.array(z.string())).default({}),
        pool: z.number().int().min(1).max(50).optional()
      })
      .default({}),
    permissions: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), permission).default({}),
    settings: z.array(settingsSection).default([]),
    ui: z.object({ screens: z.array(screen).default([]) }).default({}),
    public: z.object({ routes: z.array(z.string()).default([]) }).default({})
  })
  .strict();

export type GraftManifest = z.infer<typeof graftManifestSchema>;

export function parseManifest(raw: unknown): GraftManifest {
  const result = graftManifestSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`invalid graft.json: ${issues}`);
  }
  return result.data;
}
