import { syncGrafts } from '../grafts/sync';

syncGrafts()
  .then((result) => {
    for (const id of result.synced) process.stdout.write(`[graft-sync] ${id} ready\n`);
    for (const failure of result.failed)
      console.error(`[graft-sync] ${failure.id} failed: ${failure.reason}`);
    const strict =
      process.env.ORCHARD_GRAFTS_STRICT === '1' || process.env.ORCHARD_GRAFTS_STRICT === 'true';
    process.exit(strict && result.failed.length ? 1 : 0);
  })
  .catch((err) => {
    console.error(`[graft-sync] ${(err as Error).message}`);
    process.exit(1);
  });
