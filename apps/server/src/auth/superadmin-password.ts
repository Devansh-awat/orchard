import * as bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;
const MIN_LENGTH = 12;

// Compared against when no password is set, so a wrong address costs the same
// time as a wrong password and cannot be used to enumerate one.
const ABSENT = '$2b$12$C6UzMDM.H6dfI/f/IKcEe.5xB7PPOhNaZ9YoUjVo6/2Yks1n8kDHy';

type PasswordPrisma = {
  user: {
    findUnique(args: any): Promise<{
      id: string;
      email: string;
      isSuperAdmin: boolean;
      passwordHash: string | null;
    } | null>;
    findFirst(args: any): Promise<{ id: string; email: string } | null>;
    update(args: any): Promise<unknown>;
  };
};

export class PasswordRefused extends Error {}

/**
 * A password on the superadmin, and only there.
 *
 * Orchard signs people in with an email code, a passkey or an identity
 * provider, and an instance with none of those configured has no way back in
 * once its claim link is spent. That is the whole reason this exists, so it is
 * deliberately not a general password system: it is set from the host, where
 * root already owns the instance, it is never self-service, and there is no
 * reset flow because `orchardctl password set` is the reset flow.
 */
export async function setSuperadminPassword(
  prisma: PasswordPrisma,
  email: string,
  password: string
): Promise<string> {
  if (password.length < MIN_LENGTH) {
    throw new PasswordRefused(`a password needs at least ${MIN_LENGTH} characters`);
  }

  const user = await findSuperadmin(prisma, email);
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(password, BCRYPT_ROUNDS) }
  });
  return user.email;
}

export async function clearSuperadminPassword(
  prisma: PasswordPrisma,
  email: string
): Promise<string> {
  const user = await findSuperadmin(prisma, email);
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: null } });
  return user.email;
}

export async function superadminHasPassword(
  prisma: PasswordPrisma,
  email: string
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true, email: true, isSuperAdmin: true, passwordHash: true }
  });
  return Boolean(user?.isSuperAdmin && user.passwordHash);
}

export async function verifySuperadminPassword(
  prisma: PasswordPrisma,
  email: string,
  password: string
): Promise<{ id: string; email: string } | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    select: { id: true, email: true, isSuperAdmin: true, passwordHash: true }
  });

  const hash = user?.isSuperAdmin ? user.passwordHash : null;
  const ok = await bcrypt.compare(password, hash ?? ABSENT);
  if (!hash || !ok || !user) return null;
  return { id: user.id, email: user.email };
}

async function findSuperadmin(prisma: PasswordPrisma, email: string) {
  const address = email.toLowerCase().trim();
  if (address) {
    const user = await prisma.user.findUnique({
      where: { email: address },
      select: { id: true, email: true, isSuperAdmin: true, passwordHash: true }
    });
    if (!user) throw new PasswordRefused(`no account here uses ${address}`);
    if (!user.isSuperAdmin) throw new PasswordRefused(`${address} isn't a superadmin`);
    return user;
  }

  const only = await prisma.user.findFirst({
    where: { isSuperAdmin: true },
    select: { id: true, email: true },
    orderBy: { createdAt: 'asc' }
  });
  if (!only) {
    throw new PasswordRefused('this instance has no superadmin yet; claim it first');
  }
  return only;
}
