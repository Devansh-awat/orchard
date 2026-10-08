import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { randomBytes } from 'node:crypto';
const env = parse(readFileSync(__dirname + '/../.env'));
const creds = { token: env.SANDBOX_VERCEL_TOKEN, teamId: env.SANDBOX_VERCEL_TEAM_ID, projectId: env.SANDBOX_VERCEL_PROJECT_ID };
const red = (s: string) => s.split(creds.token).join('[redacted]');
async function main() {
  const { Sandbox } = await import('@vercel/sandbox');
  const name = `orchard-live-probe-${randomBytes(3).toString('hex')}`;
  const sb = await Sandbox.create({ name, image: 'vercel/sandbox/universal', resources: { vcpus: 2 }, timeout: 10 * 60_000, tags: { orchard_instance: 'orchard-live' }, ...creds } as any);
  console.log('created', name);
  const run = async (label: string, cmd: string, args: string[], extra: any = {}) => {
    const t0 = Date.now();
    try {
      const c = await sb.runCommand({ cmd, args, sudo: true, signal: AbortSignal.timeout(25_000), ...extra });
      const out = (await c.stdout({ signal: AbortSignal.timeout(25_000) })).trim().slice(0, 120);
      console.log(`${label}: exit ${c.exitCode} in ${((Date.now() - t0) / 1000).toFixed(1)}s ${out}`);
    } catch (e: any) {
      console.log(`${label}: threw ${e?.name} ${red(String(e?.message)).slice(0, 120)} after ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
  };
  try {
    await run('timeoutMs 2000 sleep 30', 'sleep', ['30'], { timeoutMs: 2000 });
    await run('bg plain', '/bin/sh', ['-c', 'sleep 15 >/dev/null 2>&1 & echo started']);
    await run('bg nohup stdin null', '/bin/sh', ['-c', 'nohup sleep 15 >/dev/null 2>&1 </dev/null & echo started']);
    await run('bg setsid', '/bin/sh', ['-c', 'setsid sleep 15 >/dev/null 2>&1 </dev/null & echo started']);
    await run('bg su - nohup', '/bin/sh', ['-c', "su - vercel-sandbox -c 'nohup sleep 15 >/dev/null 2>&1 &'; echo started"]);
    await run('tmux new-session -d', '/bin/sh', ['-c', "tmux new-session -d -s probe 'sleep 15' && echo started"]);
    await run('bg holding stdout', '/bin/sh', ['-c', 'sleep 15 & echo started']);
    const t0 = Date.now();
    const d = await sb.runCommand({ cmd: '/bin/sh', args: ['-c', 'echo started; sleep 60'], sudo: true, detached: true });
    await new Promise((r) => setTimeout(r, 1500));
    await d.kill();
    await new Promise((r) => setTimeout(r, 1500));
    const ps = await sb.runCommand({ cmd: '/bin/sh', args: ['-c', 'pgrep -x sleep | wc -l; ps -eo pid,ppid,args | grep "sleep 60" | grep -v grep'], sudo: true });
    console.log(`kill detached sh(sleep 60): remaining -> ${(await ps.stdout()).trim().replace(/\n/g, ' | ')} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } finally {
    await sb.delete({ deleteOrphanSnapshots: true });
    console.log('deleted');
  }
}
main().catch((e) => { console.error(red(String(e?.stack ?? e))); process.exit(1); });
