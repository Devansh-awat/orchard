import { z } from 'zod';
import type { RouteAttachment } from '../types';

const sshPublicKey = z
  .string()
  .max(4096)
  .regex(/^(ssh-(rsa|ed25519)|ecdsa-sha2-\S+)\s+\S+/, 'OpenSSH public key');

const identity = z.object({
  id: z.string().uuid(),
  name: z.string(),
  publicKey: z.string(),
  createdAt: z.string(),
});

export const attachments: Record<`${string} /${string}`, RouteAttachment> = {
  'GET /ssh-identities': {
    summary: 'List your SSH identities (named public keys attachable to sandboxes)',
    response: z.object({ identities: z.array(identity) }),
    scope: 'read',
  },
  'POST /ssh-identities': {
    summary: 'Add an SSH identity',
    request: z.object({
      name: z.string().min(1).max(100),
      publicKey: sshPublicKey,
    }),
    response: identity,
    scope: 'deploy',
  },
  'POST /ssh-identities/import-github': {
    summary: 'Import your public keys from github.com/<username>.keys as identities',
    response: z.object({ identities: z.array(identity) }),
    scope: 'deploy',
  },
  'DELETE /ssh-identities/:id': {
    summary: 'Delete an SSH identity (fails while attached to a sandbox)',
    response: z.object({ success: z.boolean() }),
    scope: 'deploy',
  },
};
