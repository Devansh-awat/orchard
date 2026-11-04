import { PrismaClient } from '@prisma/client';
import { NETWORK, isIpAddress } from '../instance-config/instance-config.sections';

async function main() {
  const ip = (process.argv[2] || '').trim();
  if (!isIpAddress(ip)) {
    console.error('usage: seed-public-ip <ip>');
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const { count } = await prisma.instanceSetting.createMany({
      data: [{ key: NETWORK.key, value: JSON.stringify({ publicIp: ip }) }],
      skipDuplicates: true
    });
    console.log(count > 0 ? `public IP set to ${ip}` : 'a network setting exists; left alone');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
