import { requestAuthStorage } from '../core/request-context';
import type {
  SandboxAccess,
  SandboxAccessRow,
  SandboxAccessService,
  SandboxMinRole
} from './sandbox-access.service';

export type SandboxAccessLevel = SandboxMinRole;

export type SandboxGateRow = SandboxAccessRow;

export async function requireSandboxAccess(
  access: SandboxAccessService,
  sandboxId: string,
  userId: string,
  level: SandboxAccessLevel
): Promise<SandboxGateRow> {
  return (await access.requireSandboxRole(sandboxId, userId, level)).sandbox;
}

export interface SandboxGateScope {
  sessionOrgId?: string | null;
  tokenProjectIds?: string[] | null;
  apiTokenId?: string | null;
  browserSession?: boolean;
}

export async function sandboxTerminalMode(
  access: SandboxAccessService,
  sandboxId: string,
  userId: string,
  requested: 'rw' | 'ro',
  scope: SandboxGateScope = {}
): Promise<{ row: SandboxGateRow; mode: 'rw' | 'ro'; access: SandboxAccess } | null> {
  const ctx = {
    ...(scope.sessionOrgId ? { sessionOrgId: scope.sessionOrgId } : {}),
    ...(scope.tokenProjectIds?.length ? { tokenProjectIds: scope.tokenProjectIds } : {}),
    ...(scope.apiTokenId ? { apiTokenId: scope.apiTokenId } : {}),
    ...(scope.browserSession ? { browserSession: true } : {})
  };
  return requestAuthStorage.run(ctx, () => terminalMode(access, sandboxId, userId, requested));
}

async function terminalMode(
  access: SandboxAccessService,
  sandboxId: string,
  userId: string,
  requested: 'rw' | 'ro'
): Promise<{ row: SandboxGateRow; mode: 'rw' | 'ro'; access: SandboxAccess } | null> {
  if (requested === 'rw') {
    const granted = await access
      .requireSandboxRole(sandboxId, userId, 'collaborator')
      .catch(() => null);
    if (granted) return { row: granted.sandbox, mode: 'rw', access: granted };
  }
  const granted = await access.requireSandboxRole(sandboxId, userId, 'viewer').catch(() => null);
  return granted ? { row: granted.sandbox, mode: 'ro', access: granted } : null;
}

export async function sandboxSshAccess(
  access: SandboxAccessService,
  sandboxId: string,
  userId: string,
  scope: SandboxGateScope = {}
): Promise<SandboxAccess | null> {
  const ctx = {
    ...(scope.sessionOrgId ? { sessionOrgId: scope.sessionOrgId } : {}),
    ...(scope.tokenProjectIds?.length ? { tokenProjectIds: scope.tokenProjectIds } : {}),
    ...(scope.apiTokenId ? { apiTokenId: scope.apiTokenId } : {}),
    ...(scope.browserSession ? { browserSession: true } : {})
  };
  return requestAuthStorage.run(ctx, () =>
    access.requireSandboxRole(sandboxId, userId, 'owner').catch(() => null)
  );
}
