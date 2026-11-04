import { PrismaClient } from '@prisma/client';
import { INGRESS, NETWORK, isIpAddress } from '../instance-config/instance-config.sections';

const USAGE =
  'usage: install-settings show | install-settings seed [--force] [--public-ip <ip>] [--cname <host>]';

const HOST = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function readFlag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  if (value === undefined) fail(USAGE);
  return value.trim();
}

async function readField(prisma: PrismaClient, key: string, field: string): Promise<string> {
  const row = await prisma.instanceSetting.findUnique({ where: { key } });
  if (!row?.value) return '';
  try {
    const parsed = JSON.parse(row.value) as Record<string, string>;
    return parsed[field] ?? '';
  } catch {
    return '';
  }
}

async function writeField(
  prisma: PrismaClient,
  key: string,
  field: string,
  value: string,
  force: boolean
): Promise<void> {
  if (!force) {
    if (value) {
      await prisma.instanceSetting.createMany({
        data: [{ key, value: JSON.stringify({ [field]: value }) }],
        skipDuplicates: true
      });
    }
    return;
  }
  if (!value) {
    await prisma.instanceSetting.deleteMany({ where: { key } });
    return;
  }
  const encoded = JSON.stringify({ [field]: value });
  await prisma.instanceSetting.upsert({
    where: { key },
    create: { key, value: encoded },
    update: { value: encoded }
  });
}

async function main() {
  const [action, ...args] = process.argv.slice(2);
  const prisma = new PrismaClient();
  try {
    if (action === 'show') {
      console.log(`publicIp=${await readField(prisma, NETWORK.key, 'publicIp')}`);
      console.log(`cname=${await readField(prisma, INGRESS.key, 'cname')}`);
      return;
    }
    if (action !== 'seed') fail(USAGE);

    const force = args.includes('--force');
    const publicIp = readFlag(args, '--public-ip');
    const cname = readFlag(args, '--cname');
    if (publicIp && !isIpAddress(publicIp)) fail(`not an IP address: ${publicIp}`);
    if (cname && !HOST.test(cname)) fail(`not a hostname: ${cname}`);

    if (publicIp !== undefined) {
      await writeField(prisma, NETWORK.key, 'publicIp', publicIp, force);
    }
    if (cname !== undefined) {
      await writeField(prisma, INGRESS.key, 'cname', cname, force);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
