import { PrismaClient } from '@prisma/client';
import {
  PasswordRefused,
  clearSuperadminPassword,
  setSuperadminPassword
} from '../auth/superadmin-password';

// Backs `orchardctl password` on the host. The password arrives on stdin so it
// never reaches a process list or a shell history, and the command that calls
// this already needs root on the box, which is ownership of the instance
// either way.
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks)
    .toString('utf8')
    .replace(/\r?\n$/, '');
}

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main() {
  const prisma = new PrismaClient();
  const email = flag('--email') ?? '';
  const clearing = process.argv.includes('--clear');

  try {
    if (clearing) {
      const who = await clearSuperadminPassword(prisma, email);
      console.log(`password removed for ${who}`);
      console.log('Sign in with a link instead: orchardctl login');
      return;
    }

    const password = await readStdin();
    if (!password) {
      console.error('no password on stdin');
      process.exitCode = 1;
      return;
    }

    const who = await setSuperadminPassword(prisma, email, password);
    console.log(`password set for ${who}`);
  } catch (err) {
    if (err instanceof PasswordRefused) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
