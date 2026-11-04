import { PrismaClient } from '@prisma/client';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { InstanceConfigService } from '../instance-config/instance-config.service';
import { STORAGE } from '../instance-config/instance-config.sections';
import { probeStorage, storageProbeTarget } from '../instance-config/storage-probe';
import { localObjectStore, setObjectStorageOverride } from '../instance-config/object-storage';

async function readInput(): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function print(value: unknown) {
  console.log(JSON.stringify(value));
}

async function main() {
  const command = process.argv[2];
  const prisma = new PrismaClient();
  const settings = {
    get: async (key: string) =>
      (await prisma.instanceSetting.findUnique({ where: { key } }))?.value ?? null,
    set: async (key: string, value: string) => {
      await prisma.instanceSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value }
      });
    },
    delete: async (key: string) => {
      await prisma.instanceSetting.deleteMany({ where: { key } });
    }
  };
  const config = new InstanceConfigService(settings as any, new SecretCryptoService());

  try {
    await config.reload();
    const state = config.state(STORAGE);
    switch (command) {
      case 'status':
        print({
          configured: Boolean(state.values.endpoint),
          endpoint: state.values.endpoint,
          bucket: state.values.backupBucket,
          region: state.values.region,
          pathStyle: state.values.pathStyle,
          lockedFields: state.lockedFields,
          localStore: localObjectStore() !== null
        });
        break;
      case 'test':
        print(await probeStorage(storageProbeTarget(await readInput(), config.all(STORAGE))));
        break;
      case 'set':
        await config.save(STORAGE, await readInput());
        print({ saved: true });
        break;
      case 'clear':
        await config.clear(STORAGE);
        setObjectStorageOverride({});
        print({ cleared: true });
        break;
      default:
        console.error('usage: storage-config status|test|set|clear');
        process.exitCode = 1;
    }
  } catch (e: any) {
    console.error(e?.response?.message ?? e?.message ?? 'failed');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
