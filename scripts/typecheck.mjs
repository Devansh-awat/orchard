#!/usr/bin/env node
// Typechecks every TypeScript project with TypeScript 7 and reports how long it
// took and how much memory it needed.
//
// TS 7 is the Go port, so the whole repo checks in a few seconds. TS 5 could
// never run here anyway: it is the version that removed `baseUrl` and
// `moduleResolution: node10`, both of which the old server config used.
//
// The server checks through tsconfig.check.json rather than tsconfig.json
// because the build emits through swc, and the check-only config picks the
// module resolution that matches what Node actually does at runtime.

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const TS_VERSION = '7.0.2';

const PROJECTS = [
  { name: 'server', config: 'apps/server/tsconfig.check.json' },
  { name: 'frontend', config: 'apps/frontend/tsconfig.json' },
  { name: 'contracts', config: 'packages/contracts/tsconfig.json' }
];

const root = resolve(import.meta.dirname, '..');

// A parent cannot read /proc for a process that has already exited, so peak RSS
// has to come from time(1). GNU time (Linux, and so CI) spells the flag -v and
// BSD time (macOS) spells it -l; probe rather than guess, and drop the wrapper
// entirely if neither works so the check still runs.
const TIME_FLAG = existsSync('/usr/bin/time')
  ? ['-v', '-l'].find((flag) => spawnSync('/usr/bin/time', [flag, 'true']).status === 0)
  : undefined;

function peakRssBytes(stderr) {
  const gnu = stderr.match(/Maximum resident set size \(kbytes\): (\d+)/);
  if (gnu) return Number(gnu[1]) * 1024;
  const bsd = stderr.match(/(\d+)\s+maximum resident set size/);
  if (bsd) return Number(bsd[1]);
  return null;
}

function run(project) {
  const tsc = [
    'npx',
    '-y',
    '-p',
    `typescript@${TS_VERSION}`,
    'tsc',
    '--noEmit',
    '-p',
    project.config
  ];
  const argv = TIME_FLAG ? ['/usr/bin/time', TIME_FLAG, ...tsc] : tsc;

  const started = Date.now();
  const proc = spawnSync(argv[0], argv.slice(1), {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  });
  const ms = Date.now() - started;

  const output = `${proc.stdout ?? ''}${proc.stderr ?? ''}`;
  const errors = output.split('\n').filter((l) => /error TS\d+:/.test(l));
  // tsc exits non-zero when it reports errors. A non-zero exit with nothing
  // parsed means it never ran, and reporting that as clean would make a broken
  // step look green.
  const crashed = proc.status !== 0 && errors.length === 0;
  return { ...project, ms, errors, crashed, peak: peakRssBytes(proc.stderr ?? ''), output };
}

const mib = (b) => (b == null ? null : `${(b / 1024 ** 2).toFixed(0)} MiB`);
const secs = (ms) => `${(ms / 1000).toFixed(2)}s`;

const results = PROJECTS.map(run);
const failed = results.filter((r) => r.errors.length > 0 || r.crashed);
const totalMs = results.reduce((a, r) => a + r.ms, 0);
const peak = results.reduce((a, r) => Math.max(a, r.peak ?? 0), 0);

for (const r of failed) {
  console.log(`\n── ${r.name} ──`);
  console.log(r.crashed ? r.output.trim() : r.errors.join('\n'));
}

const status = (r) => {
  if (r.crashed) return '💥 did not run';
  return r.errors.length === 0 ? '✅ clean' : `❌ ${r.errors.length}`;
};

const rows = results.map(
  (r) => `| ${r.name} | ${status(r)} | ${secs(r.ms)} | ${mib(r.peak) ?? 'n/a'} |`
);

const summary = [
  `## Typecheck — TypeScript ${TS_VERSION}`,
  '',
  '| project | result | time | peak memory |',
  '| --- | --- | --- | --- |',
  ...rows,
  `| **total** | ${failed.length === 0 ? '**✅ 0 errors**' : `**❌ ${failed.reduce((a, r) => a + r.errors.length, 0)} errors**`} | **${secs(totalMs)}** | **${mib(peak) ?? 'n/a'}** |`,
  '',
  failed.length === 0
    ? `Checked ${results.length} projects in ${secs(totalMs)}${peak ? ` using at most ${mib(peak)}` : ''}. Nothing to fix.`
    : `${failed.map((r) => r.name).join(', ')} did not typecheck. Errors are in the job log.`
].join('\n');

console.log(`\n${summary}`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

process.exit(failed.length === 0 ? 0 : 1);
