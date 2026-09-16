import { PrismaClient } from '@prisma/client';
import { OTP_EXPIRY_MINUTES, generateOtpCode, hashOtpCode } from '../auth/otp-code';

// Backs `orchardctl login` on the host. It mints the same one-time code the
// email flow does and prints it instead of mailing it, which is what makes an
// instance with no SMTP, no identity provider and no TLS for passkeys still
// signable-into. Whoever runs this has root on the box and could mint a
// session by hand, so it hands out nothing new.
function flag(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function loginUrl(email: string, code: string, base?: string): string {
  const origin = (base || process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${origin}/?email=${encodeURIComponent(email)}&code=${code}`;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const asked = (flag('--email') ?? '').toLowerCase().trim();
    const user = asked
      ? await prisma.user.findUnique({ where: { email: asked }, select: { email: true } })
      : await prisma.user.findFirst({
          where: { isSuperAdmin: true },
          select: { email: true },
          orderBy: { createdAt: 'asc' }
        });

    if (!user) {
      console.error(
        asked
          ? `no account here uses ${asked}`
          : 'this instance has no superadmin yet. Claim it first: orchardctl claim'
      );
      process.exitCode = 1;
      return;
    }

    // Any code already outstanding for this address stops working, so a link
    // left in a scrollback cannot be redeemed after a newer one is minted.
    await prisma.otpCode.updateMany({
      where: { email: user.email, used: false, expiresAt: { gt: new Date() } },
      data: { used: true }
    });

    const code = generateOtpCode();
    await prisma.otpCode.create({
      data: {
        email: user.email,
        code: hashOtpCode(code),
        expiresAt: new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000),
        attempts: 0,
        used: false
      }
    });

    console.log('');
    console.log(`  Open this to sign in as ${user.email} (valid for ${OTP_EXPIRY_MINUTES} minutes):`);
    console.log('');
    console.log(`    ${loginUrl(user.email, code, flag('--url'))}`);
    console.log('');
    console.log('  It works once. The code on its own also works in the sign-in form.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
