import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import {
  SUPERADMIN_CLAIM_KEY,
  CLAIM_TTL_MS,
  hashClaimToken,
  claimUrl,
  recoveryState
} from '../setup/setup-token';

// Backs `orchard-claim` on the host. The claim token is only ever stored
// hashed, so a lost one cannot be recovered — this mints a replacement and
// prints it. Reaching this means having exec on the server pod, which is
// already equivalent to owning the instance, so it grants nothing new.
// `orchardctl claim --url` passes the address the operator can actually reach,
// which is not always the one links are generated with: a LAN box answers on
// its IP, its machine name and whatever else Traefik was told about.
function baseFromArgs(argv: string[]): string | undefined {
  const at = argv.indexOf('--url');
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value) return undefined;
  return /^https?:\/\//.test(value) ? value : `http://${value}`;
}

async function main() {
  const base = baseFromArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const state = await recoveryState(prisma);
    if (!state.claimable) {
      console.log('This instance already has a superadmin, and a way to sign in as them.');
      if (state.blockedBy === 'passkey') {
        console.log('Use your passkey. This only mints a link when there is no other way in.');
      } else if (state.blockedBy === 'smtp') {
        console.log('Sign in with an email code. Email is configured on this instance.');
      } else {
        console.log('Sign in with your identity provider, which is configured on this instance.');
      }
      return;
    }

    const recovering = state.superadmins > 0;

    const token = randomBytes(32).toString('base64url');
    const value = JSON.stringify({
      hash: hashClaimToken(token),
      expiresAt: new Date(Date.now() + CLAIM_TTL_MS).toISOString()
    });

    await prisma.instanceSetting.upsert({
      where: { key: SUPERADMIN_CLAIM_KEY },
      create: { key: SUPERADMIN_CLAIM_KEY, value },
      update: { value }
    });

    console.log('');
    if (recovering) {
      console.log('  No passkey, no email and no identity provider on this instance, so');
      console.log('  there is no way to sign in as the superadmin it already has.');
      console.log('');
      console.log('  Open this to sign back in (valid for 24 hours). Use the same email');
      console.log('  address as before, or you will create a second superadmin:');
    } else {
      console.log('  Open this to claim the instance and sign in (valid for 24 hours):');
    }
    console.log('');
    console.log(`    ${claimUrl(token, base)}`);
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
