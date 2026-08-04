import { z } from 'zod';
import type { RouteAttachment } from '../types';

const sandboxStatus = z.enum([
  'creating',
  'starting',
  'running',
  'stopping',
  'stopped',
  'deleting',
  'error',
]);

const sshPublicKey = z
  .string()
  .max(4096)
  .regex(/^(ssh-(rsa|ed25519)|ecdsa-sha2-\S+)\s+\S+/, 'OpenSSH public key');

const sandboxName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'lowercase DNS label');

const sandbox = z.object({
  id: z.string().uuid(),
  name: z.string(),
  status: sandboxStatus,
  statusMessage: z.string().nullable(),
  repoUrl: z.string().nullable(),
  sshPublicKeys: z.array(z.string()),
  image: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastActiveAt: z.string().nullable(),
});

const credentialPresence = z.object({
  claude: z.boolean().describe('Whether a Claude Code OAuth token is stored'),
  openai: z.boolean().describe('Whether an OpenAI/Codex token is stored'),
});

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /sandboxes': {
    summary: 'List your sandboxes with your effective sandbox limit',
    response: z.object({ sandboxes: z.array(sandbox), maxSandboxes: z.number().int() }),
    scope: 'read',
  },
  'POST /sandboxes': {
    summary: 'Create an isolated cloud dev sandbox (Kata VM, internet egress only)',
    request: z.object({
      name: sandboxName.optional().describe('Defaults to "sandbox" (or a suffixed variant)'),
      repoUrl: z.string().url().optional().describe('https git URL cloned into the sandbox on boot'),
      sshPublicKeys: z.array(sshPublicKey).max(10).optional(),
      importGithubKeys: z
        .boolean()
        .optional()
        .describe('Merge public keys from github.com/<your-username>.keys'),
    }),
    response: sandbox,
    scope: 'deploy',
  },
  'GET /sandboxes/credentials': {
    summary: 'Check which agent credentials are configured (presence only, never values)',
    response: credentialPresence,
    scope: 'read',
  },
  'PUT /sandboxes/credentials': {
    summary: 'Store or clear agent subscription tokens (encrypted at rest), null clears',
    request: z.object({
      claudeToken: z.string().max(8192).nullable().optional(),
      openaiToken: z.string().max(8192).nullable().optional(),
    }),
    response: credentialPresence,
    scope: 'deploy',
  },
  'GET /sandboxes/:id': {
    summary: 'Get a sandbox',
    response: sandbox,
    scope: 'read',
  },
  'PATCH /sandboxes/:id': {
    summary: "Rename a sandbox or replace its SSH public key set",
    request: z.object({
      name: sandboxName.optional(),
      sshPublicKeys: z.array(sshPublicKey).max(10).optional(),
      importGithubKeys: z.boolean().optional(),
    }),
    response: sandbox,
    scope: 'deploy',
  },
  'POST /sandboxes/:id/start': {
    summary: 'Resume a stopped sandbox (workspace and host key persist)',
    response: sandbox,
    scope: 'deploy',
  },
  'POST /sandboxes/:id/stop': {
    summary: 'Suspend a running sandbox (workspace and host key persist)',
    response: sandbox,
    scope: 'deploy',
  },
  'DELETE /sandboxes/:id': {
    summary: 'Delete a sandbox and its persistent workspace',
    response: z.object({ success: z.boolean() }),
    scope: 'deploy',
  },
  'GET /sandboxes/:id/ssh': {
    summary:
      'WebSocket tunnel to the sandbox sshd (binary frames carry raw TCP bytes; used by orchard sandbox ssh/proxy)',
    scope: 'exec',
  },
};
