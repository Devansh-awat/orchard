import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  SUPERADMIN_CLAIM_KEY,
  CLAIM_TTL_MS,
  hashClaimToken,
  claimUrl,
} from '../setup/setup-token';

// Backs `orchard-claim` on the host. The claim token is only ever stored
// hashed, so a lost one cannot be recovered — this mints a replacement and
// prints it. Reaching this means having exec on the server pod, which is
// already equivalent to owning the instance, so it grants nothing new.
async function main() {
  const prisma = new PrismaClient();
  try {
    const superadmins = await prisma.user.count({ where: { isSuperAdmin: true } });
    if (superadmins > 0) {
      console.log('This instance already has a superadmin, so there is nothing to claim.');
      console.log('Sign in with your passkey, or add one from Settings if you have not yet.');
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const value = JSON.stringify({
      hash: hashClaimToken(token),
      expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString(),
    });

    await prisma.instanceSetting.upsert({
      where: { key: SUPERADMIN_CLAIM_KEY },
      create: { key: SUPERADMIN_CLAIM_KEY, value },
      update: { value },
    });

    console.log('');
    console.log('  Open this to claim the instance and sign in (valid for 24 hours):');
    console.log('');
    console.log(`    ${claimUrl(token)}`);
    console.log('');
    console.log('  It works once. Add a passkey straight after so you can sign back in.');
    console.log('');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(`could not mint a claim link: ${e?.message || e}`);
  process.exit(1);
});
