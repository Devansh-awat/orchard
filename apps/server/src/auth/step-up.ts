import * as bcrypt from 'bcrypt';
import { MCP_SESSION_AUTH_METHOD } from './sessions.service';

export const RECENT_SIGN_IN_MS = 10 * 60 * 1000;

export type StepUpCode =
  | 'current_password_required'
  | 'current_password_incorrect'
  | 'reauth_required';

export type StepUpRefusal = { code: StepUpCode; message: string };

type StepUpPrisma = {
  session: {
    findFirst(args: any): Promise<{ createdAt: Date; authMethod: string | null } | null>;
  };
};

export async function stepUp(
  prisma: StepUpPrisma,
  input: {
    action: string;
    user: { id: string; passwordHash: string | null };
    currentPassword?: unknown;
    auth?: { sessionId?: string; apiTokenId?: string };
    now?: Date;
  }
): Promise<StepUpRefusal | null> {
  const { action, user, currentPassword, auth } = input;

  if (user.passwordHash) {
    if (typeof currentPassword !== 'string' || !currentPassword) {
      return {
        code: 'current_password_required',
        message: `Enter your current password to ${action}.`
      };
    }
    if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
      return { code: 'current_password_incorrect', message: 'Your current password is wrong.' };
    }
    return null;
  }

  const reauth: StepUpRefusal = {
    code: 'reauth_required',
    message: `Sign in again to ${action}. It needs a sign-in from the last 10 minutes.`
  };
  if (!auth?.sessionId || auth.apiTokenId) return reauth;
  const session = await prisma.session.findFirst({
    where: { id: auth.sessionId, userId: user.id, revokedAt: null },
    select: { createdAt: true, authMethod: true }
  });
  if (!session || session.authMethod === MCP_SESSION_AUTH_METHOD) return reauth;
  const age = (input.now ?? new Date()).getTime() - session.createdAt.getTime();
  if (age > RECENT_SIGN_IN_MS) return reauth;
  return null;
}
