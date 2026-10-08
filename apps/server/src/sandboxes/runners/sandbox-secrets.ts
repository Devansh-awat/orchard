import { Injectable, Optional } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { SignJWT } from 'jose';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretCryptoService } from '../../crypto/secret-crypto.service';
import type { SandboxSecrets } from './sandbox-runner';
import { SandboxProjectEnvService } from '../links/sandbox-project-env.service';
import { gitIdentity } from '../sandbox-git-identity';
import { SANDBOX_MCP_DEVICE, sandboxMcpDevice } from '../../auth/sandbox-mcp-scope';

export type SandboxSecretPurpose = 'opencode-password' | 'bridge-token' | 'spec-hash';

function secretsKey(): string | null {
  const key = process.env.SECRETS_ENCRYPTION_KEY || process.env.SSO_ENCRYPTION_KEY;
  return key && key.length > 0 ? key : null;
}

export type SandboxBoxSecretPurpose = Exclude<SandboxSecretPurpose, 'spec-hash'>;

export function deriveSandboxSecret(
  purpose: SandboxSecretPurpose,
  sandboxId: string,
  key: string | null = secretsKey(),
  epoch = 0
): string | null {
  if (!key) return null;
  const input =
    epoch > 0
      ? `orchard-sandbox:${purpose}:${sandboxId}:${epoch}`
      : `orchard-sandbox:${purpose}:${sandboxId}`;
  return createHmac('sha256', key).update(input).digest('base64url');
}

export function deriveBoxSecret(
  purpose: SandboxBoxSecretPurpose,
  sandboxId: string,
  epoch: number
): string | null {
  return deriveSandboxSecret(purpose, sandboxId, secretsKey(), epoch);
}

export function sandboxSpecHash(sandboxId: string, data: Record<string, string>): string {
  const canonical = JSON.stringify(
    Object.keys(data)
      .sort()
      .map((k) => [k, data[k]])
  );
  const key = deriveSandboxSecret('spec-hash', sandboxId);
  const digest = key
    ? createHmac('sha256', key).update(canonical).digest('hex')
    : createHash('sha256').update(canonical).digest('hex');
  return digest.slice(0, 32);
}

@Injectable()
export class SandboxSecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService,
    @Optional() private readonly projectEnv?: SandboxProjectEnvService
  ) {}

  async authorizedKeys(userId: string): Promise<string[]> {
    const identities = await this.prisma.sshIdentity.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: { publicKey: true }
    });
    return [...new Set(identities.map((i) => i.publicKey.trim()).filter(Boolean))];
  }

  async secretEpoch(sandboxId: string): Promise<number> {
    const row = await this.prisma.sandbox.findUnique({
      where: { id: sandboxId },
      select: { secretEpoch: true }
    });
    return row?.secretEpoch ?? 0;
  }

  async boxSecret(purpose: SandboxBoxSecretPurpose, sandboxId: string): Promise<string | null> {
    return deriveBoxSecret(purpose, sandboxId, await this.secretEpoch(sandboxId));
  }

  async forSandbox(row: {
    id: string;
    userId: string;
    setupScript: string | null;
  }): Promise<SandboxSecrets> {
    const [authorizedKeys, user, credential, mcpToken, attachedEnv, epoch] = await Promise.all([
      this.authorizedKeys(row.userId),
      this.prisma.user.findUnique({
        where: { id: row.userId },
        select: {
          id: true,
          username: true,
          email: true,
          firstName: true,
          lastName: true,
          githubId: true,
          githubUsername: true,
          githubAccessToken: true
        }
      }),
      this.prisma.sandboxCredential.findUnique({ where: { userId: row.userId } }),
      this.mintMcpToken(row.userId, row.id).catch(() => null),
      this.projectEnv ? this.projectEnv.filesFor(row.id) : Promise.resolve({}),
      this.secretEpoch(row.id)
    ]);
    return {
      authorizedKeys,
      githubToken: this.crypto.open(user?.githubAccessToken) || null,
      claudeToken: credential?.claudeToken ? this.crypto.decrypt(credential.claudeToken) : null,
      openaiToken: credential?.openaiToken ? this.crypto.decrypt(credential.openaiToken) : null,
      setupScript: row.setupScript,
      mcpToken,
      opencodePassword: deriveBoxSecret('opencode-password', row.id, epoch),
      bridgeToken: deriveBoxSecret('bridge-token', row.id, epoch),
      attachedEnv,
      gitIdentity: user ? gitIdentity(user) : null
    };
  }

  async mintMcpToken(userId: string, sandboxId: string): Promise<string | null> {
    if (!process.env.SANDBOX_MCP_URL || !process.env.JWT_SECRET) return null;
    const [user, sandbox] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, username: true, externalAuthId: true }
      }),
      this.prisma.sandbox.findUnique({
        where: { id: sandboxId },
        select: { organizationId: true }
      })
    ]);
    if (!user || !sandbox) return null;
    const deviceName = sandboxMcpDevice(sandbox.organizationId, sandboxId);
    await this.prisma.session.updateMany({
      where: { userId, deviceName: SANDBOX_MCP_DEVICE, revokedAt: null },
      data: { revokedAt: new Date() }
    });
    let session = await this.prisma.session.findFirst({
      where: {
        userId,
        deviceName,
        revokedAt: null,
        expiresAt: { gt: new Date(Date.now() + 7 * 86400000) }
      }
    });
    if (!session) {
      session = await this.prisma.session.create({
        data: {
          userId,
          authMethod: 'otp',
          deviceName,
          expiresAt: new Date(Date.now() + 60 * 86400000)
        }
      });
    }
    return new SignJWT({
      type: 'mcp',
      email: user.email,
      name: user.username,
      externalAuthId: user.externalAuthId,
      authMethod: 'otp',
      sessionId: session.id
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime('60d')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
  }
}
