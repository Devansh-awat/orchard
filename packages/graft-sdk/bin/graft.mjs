#!/usr/bin/env node
import { run } from '../cli/index.mjs';

run(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`graft: ${err?.stack ?? err}\n`);
  process.exit(1);
});
