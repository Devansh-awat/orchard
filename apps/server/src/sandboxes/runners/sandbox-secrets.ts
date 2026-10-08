import { Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'crypto';
import { SignJWT } from 'jose';
import { PrismaService } from '../../prisma/prisma.service';
import { SecretCryptoService } from '../../crypto/secret-crypto.service';
import type { SandboxSecrets } from './sandbox-runner';

export type SandboxSecretPurpose = 'opencode-password' | 'bridge-token' | 'spec-hash';

function secretsKey(): string | null {
  const key = process.env.SECRETS_ENCRYPTION_KEY || process.env.SSO_ENCRYPTION_KEY;
  return key && key.length > 0 ? key : null;
}

export function deriveSandboxSecret(
  purpose: SandboxSecretPurpose,
  sandboxId: string,
  key: string | null = secretsKey()
): string | null {
  if (!key) return null;
  return createHmac('sha256', key)
    .update(`orchard-sandbox:${purpose}:${sandboxId}`)
    .digest('base64url');
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

const MCP_SESSION_DEVICE = 'sandbox-mcp';

@Injectable()
export class SandboxSecretsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: SecretCryptoService
  ) {}

  async forSandbox(row: {
    id: string;
    userId: string;
    sshIdentityId: string | null;
    setupScript: string | null;
  }): Promise<SandboxSecrets> {
    const identity = row.sshIdentityId
      ? await this.prisma.sshIdentity.findUnique({
          where: { id: row.sshIdentityId },
          select: { publicKey: true }
        })
      : null;
    const [user, credential, mcpToken] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: row.userId },
        select: { githubAccessToken: true }
      }),
      this.prisma.sandboxCredential.findUnique({ where: { userId: row.userId } }),
      this.mintMcpToken(row.userId).catch(() => null)
    ]);
    return {
      authorizedKeys: identity ? [identity.publicKey] : [],
      githubToken: this.crypto.open(user?.githubAccessToken) || null,
      claudeToken: credential?.claudeToken ? this.crypto.decrypt(credential.claudeToken) : null,
      openaiToken: credential?.openaiToken ? this.crypto.decrypt(credential.openaiToken) : null,
      setupScript: row.setupScript,
      mcpToken,
      opencodePassword: deriveSandboxSecret('opencode-password', row.id),
      bridgeToken: deriveSandboxSecret('bridge-token', row.id)
    };
  }

  private async mintMcpToken(userId: string): Promise<string | null> {
    if (!process.env.SANDBOX_MCP_URL || !process.env.JWT_SECRET) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, username: true, externalAuthId: true }
    });
    if (!user) return null;
    let session = await this.prisma.session.findFirst({
      where: {
        userId,
        deviceName: MCP_SESSION_DEVICE,
        revokedAt: null,
        expiresAt: { gt: new Date(Date.now() + 7 * 86400000) }
      }
    });
    if (!session) {
      session = await this.prisma.session.create({
        data: {
          userId,
          authMethod: 'otp',
          deviceName: MCP_SESSION_DEVICE,
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
