import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  COAUTHOR_HOOK_NAMES,
  COAUTHOR_HOOK_SCRIPT,
  buildCoauthorHookInstall,
  buildCoauthorUpdate,
  coauthorLine
} from '../src/sandboxes/sandbox-coauthors';
import { SandboxCoauthorsService } from '../src/sandboxes/sandbox-coauthors.service';
import {
  FS_EXIT,
  HOME_ROOT,
  READ_EXIT,
  buildConfinedPathCheck,
  buildConfinedReadScript,
  buildDiffstatBatchScript,
  buildFsScript,
  buildScriptLaunch,
  buildWorktreeAddScript,
  buildWorktreeRemoveScript,
  isTerminalIndex,
  isValidGitRef,
  isValidRepoName,
  isValidSlug,
  isWorktreePath,
  normalizeRelativePath,
  parseDiffstatBatch,
  parseGreenhouseConfig,
  parsePortsOutput,
  parseScriptsProbe,
  parseShortstat,
  parseWorktreeAddOutput,
  sandboxTerminalCommand,
  scriptFiles,
  sessionStateDir,
  setupStateOf,
  shellQuote,
  slugify,
  tmuxSessionName
} from '../src/sandboxes/sandbox-session-commands';
import { parseSandboxTerminalQuery } from '../src/sandboxes/sandbox-terminal.gateway';
import {
  activityFromStatus,
  excerptLog,
  parseGithubRemote,
  parseIssueRef,
  parsePrUrl
} from '../src/sandboxes/sandbox-sessions.service';
import { SandboxSessionsService } from '../src/sandboxes/sandbox-sessions.service';
import { SandboxWorkspaceService } from '../src/sandboxes/sandbox-workspace.service';
import { SandboxAgentService } from '../src/sandboxes/sandbox-agent.service';
import { KubernetesSandboxRunner } from '../src/sandboxes/runners/kubernetes.runner';
import {
  MAX_DECLARED_PREVIEW_PORTS,
  declaredPreviewPorts,
  isPreviewPortAllowed,
  isPreviewPortCandidate,
  mergeDeclaredPorts
} from '../src/sandboxes/preview/preview-auth';

const SID = '3f2d7e6a-1b0c-4d5e-8f90-123456789abc';
const SID2 = 'aaaaaaaa-1b0c-4d5e-8f90-123456789abc';

function sh(script: string): string {
  return execFileSync('/bin/sh', ['-c', script], { encoding: 'utf8' });
}

test('shell quoting survives every hostile character a branch or path could carry', () => {
  for (const value of ["it's", '$(rm -rf /)', '`id`', 'a"b', 'line\nbreak', '; ls', "''", '\\']) {
    assert.equal(sh(`printf '%s' ${shellQuote(value)}`), value);
  }
});

test('git refs follow check-ref-format and reject injection', () => {
  for (const ok of ['main', 'release/1.2', 'feat/x-y_z', 'v1.0.0', 'orchard/fix-login-a1b2']) {
    assert.equal(isValidGitRef(ok), true, ok);
  }
  for (const bad of [
    '',
    '-rf',
    '--upload-pack=evil',
    'a..b',
    'a//b',
    '/main',
    'main/',
    'main.',
    'x.lock',
    'a/.hidden',
    '@',
    'a@{1}',
    'has space',
    'semi;colon',
    '$(id)',
    'back`tick',
    'tilde~1',
    'caret^',
    'colon:x',
    'q?',
    'star*',
    'brack[',
    'back\\slash',
    'x'.repeat(201)
  ]) {
    assert.equal(isValidGitRef(bad), false, bad);
  }
});

test('repo names, slugs and worktree paths are tightly shaped', () => {
  assert.equal(isValidRepoName('orchard'), true);
  assert.equal(isValidRepoName('my.repo-1'), true);
  for (const bad of ['', '.hidden', '../x', 'a/b', 'a..b', 'x.lock', '-x', 'a b']) {
    assert.equal(isValidRepoName(bad), false, bad);
  }
  assert.equal(isValidSlug('fix-login-a1b2c3'), true);
  for (const bad of ['', '-a', 'a-', 'A', 'a--b', 'a_b', 'a/b', 'x'.repeat(65)]) {
    assert.equal(isValidSlug(bad), false, bad);
  }
  assert.equal(isWorktreePath('/persist/home/.worktrees/app/fix-a1b2'), true);
  for (const bad of [
    '/persist/home/app',
    '/persist/home/.worktrees/app',
    '/persist/home/.worktrees/app/fix/extra',
    '/persist/home/.worktrees/../.ssh/x',
    '/persist/home/.worktrees/app/../x',
    '/persist/home/.worktrees//app/x',
    '/persist/home/.worktrees/app/Fix'
  ]) {
    assert.equal(isWorktreePath(bad), false, bad);
  }
});

test('slugs are derived from the title and always valid', () => {
  assert.equal(slugify('Fix the login bug!', 'a1b2c3'), 'fix-the-login-bug-a1b2c3');
  assert.equal(slugify('   ', 'ff00'), 'session-ff00');
  assert.equal(slugify('Ünïcödé — names', '01'), 'unicode-names-01');
  for (const title of ['---', '$(rm)', 'x'.repeat(300), '../../etc/passwd', '日本語']) {
    assert.equal(isValidSlug(slugify(title, 'abc123')), true, title);
  }
});

test('worktree creation quotes every input and branches under orchard/', () => {
  const script = buildWorktreeAddScript({ repo: 'app', slug: 'fix-a1b2', baseBranch: 'main' });
  assert.match(
    script,
    /git -C '\/persist\/home\/app' worktree add --quiet --no-track -b 'orchard\/fix-a1b2' '\/persist\/home\/\.worktrees\/app\/fix-a1b2' "\$start"/
  );
  assert.match(script, /base='main'/);
  const auto = buildWorktreeAddScript({ repo: 'app', slug: 'fix-a1b2', baseBranch: null });
  assert.match(auto, /symbolic-ref --quiet --short refs\/remotes\/origin\/HEAD/);
  assert.throws(() => buildWorktreeAddScript({ repo: '../x', slug: 'a', baseBranch: null }));
  assert.throws(() => buildWorktreeAddScript({ repo: 'app', slug: 'A;B', baseBranch: null }));
  assert.throws(() => buildWorktreeAddScript({ repo: 'app', slug: 'a', baseBranch: '$(id)' }));
  assert.deepEqual(parseWorktreeAddOutput('noise\n@@base@@main\n@@commit@@0123456789abcdef\n'), {
    baseBranch: 'main',
    baseCommit: '0123456789abcdef'
  });
  assert.deepEqual(parseWorktreeAddOutput(''), { baseBranch: null, baseCommit: null });
});

test('archiving keeps the branch, deleting can remove it, and tmux sessions are scoped to the session', () => {
  const archive = buildWorktreeRemoveScript('app', 'fix-a1b2', SID);
  assert.match(archive, /worktree remove --force '\/persist\/home\/\.worktrees\/app\/fix-a1b2'/);
  assert.doesNotMatch(archive, /branch -D/);
  assert.match(archive, /'orchard-3f2d7e6a-'/);
  const remove = buildWorktreeRemoveScript('app', 'fix-a1b2', SID, {
    deleteBranch: true,
    purgeState: true
  });
  assert.match(remove, /branch -D 'orchard\/fix-a1b2'/);
  assert.match(remove, new RegExp(`rm -rf -- '/persist/home/.orchard/sessions/${SID}'`));
  assert.equal(tmuxSessionName(SID, '0'), 'orchard-3f2d7e6a-0');
  assert.equal(tmuxSessionName(SID, 'setup'), 'orchard-3f2d7e6a-setup');
});

test('.orchard/greenhouse.json parsing tolerates junk and bounds what it keeps', () => {
  assert.deepEqual(
    parseGreenhouseConfig(
      '{"setup":"pnpm i","run":["pnpm dev","echo hi"],"ports":[3000,"5173",0,70000,3000,"x",80,1023,22,2222,4096,1024,65535]}'
    ),
    { setup: 'pnpm i', run: 'pnpm dev\necho hi', ports: [3000, 5173, 1024, 65535] }
  );
  for (const junk of [null, '', 'not json', '[]', '42', '{"setup":5,"ports":"3000"}']) {
    assert.deepEqual(
      parseGreenhouseConfig(junk),
      { setup: null, run: null, ports: [] },
      String(junk)
    );
  }
  assert.equal(parseGreenhouseConfig(JSON.stringify({ setup: 'x'.repeat(70000) })).setup, null);
  assert.equal(parseGreenhouseConfig(JSON.stringify({ setup: '   ' })).setup, null);
  const many = parseGreenhouseConfig(
    JSON.stringify({ ports: Array.from({ length: 40 }, (_, i) => 3000 + i) })
  );
  assert.equal(many.ports.length, 10);
});

test('the scripts probe splits on a per-call nonce so config content cannot spoof sections', () => {
  const nonce = 'abc123';
  const out = `@@${nonce}:config@@\n{"run":"echo @@x:setup@@"}\n@@${nonce}:setup@@\nfailed 2\n\n@@${nonce}:run@@\n0\n`;
  assert.deepEqual(parseScriptsProbe(out, nonce), {
    configText: '{"run":"echo @@x:setup@@"}',
    setupStatus: 'failed 2',
    runPaneDead: '0'
  });
  assert.deepEqual(parseScriptsProbe('garbage', nonce), {
    configText: null,
    setupStatus: null,
    runPaneDead: null
  });
  assert.equal(setupStateOf(null), 'none');
  assert.equal(setupStateOf('running'), 'running');
  assert.equal(setupStateOf('done'), 'done');
  assert.equal(setupStateOf('failed 127'), 'failed');
  assert.equal(setupStateOf('weird'), 'none');
});

test('setup and run launch in their own tmux session and wait for the pipe before starting', () => {
  const launch = {
    name: 'setup' as const,
    sessionId: SID,
    worktreePath: '/persist/home/.worktrees/app/fix-a1b2',
    repoPath: '/persist/home/app'
  };
  const files = scriptFiles(launch);
  assert.equal(files.userPath, `/persist/home/.orchard/sessions/${SID}/setup.user.sh`);
  assert.match(files.wrapper, /tmux wait-for 'orchard-3f2d7e6a-setup-go'/);
  assert.match(files.wrapper, /ORCHARD_ROOT_PATH='\/persist\/home\/app'/);
  const script = buildScriptLaunch(launch);
  assert.match(script, /new-session -d -s 'orchard-3f2d7e6a-setup' -n 'setup'/);
  assert.match(script, /remain-on-exit on/);
  assert.match(script, /pipe-pane/);
  assert.ok(script.indexOf('pipe-pane') < script.indexOf('wait-for -S'));
});

test('diffstat for every session comes back from one batched script', () => {
  const script = buildDiffstatBatchScript([
    {
      id: SID,
      worktreePath: '/persist/home/.worktrees/app/a',
      baseBranch: 'main',
      baseCommit: 'abc1234'
    },
    {
      id: SID2,
      worktreePath: '/persist/home/.worktrees/app/b',
      baseBranch: null,
      baseCommit: null
    },
    {
      id: 'not-a-uuid',
      worktreePath: '/persist/home/.worktrees/app/c',
      baseBranch: 'main',
      baseCommit: null
    },
    { id: SID, worktreePath: '/etc', baseBranch: 'main', baseCommit: null }
  ]);
  assert.equal(script.match(/@@s %s/g)?.length, 2);
  assert.doesNotMatch(script, /not-a-uuid|\/etc/);
  const out = [
    `@@s ${SID}`,
    '@@d  3 files changed, 10 insertions(+), 2 deletions(-)',
    '@@u 2',
    '@@ab 1 4',
    `@@s ${SID2}`,
    '@@d ',
    '@@u 0',
    '@@ab 0 0',
    '@@s not-a-uuid',
    '@@d  9 files changed'
  ].join('\n');
  const parsed = parseDiffstatBatch(out);
  assert.equal(parsed.size, 2);
  assert.deepEqual(parsed.get(SID), {
    diffstat: { files: 5, additions: 10, deletions: 2 },
    aheadBehind: { ahead: 4, behind: 1 }
  });
  assert.deepEqual(parsed.get(SID2), {
    diffstat: { files: 0, additions: 0, deletions: 0 },
    aheadBehind: { ahead: 0, behind: 0 }
  });
  assert.deepEqual(parseShortstat(' 1 file changed, 1 insertion(+)'), {
    files: 1,
    additions: 1,
    deletions: 0
  });
});

test('relative fs paths reject traversal, absolute paths and .git', () => {
  assert.equal(normalizeRelativePath('src/app.ts'), 'src/app.ts');
  assert.equal(normalizeRelativePath('src/./lib//x/'), 'src/lib/x');
  assert.equal(normalizeRelativePath('a/b/../c'), 'a/c');
  for (const bad of [
    '',
    '.',
    '..',
    '../x',
    'a/../../x',
    '/etc/passwd',
    '~/x',
    '.git/config',
    'sub/.git/hooks/pre-commit',
    'a\0b',
    'a\nb',
    'x'.repeat(1025)
  ]) {
    assert.equal(normalizeRelativePath(bad), null, JSON.stringify(bad));
  }
  assert.throws(() => buildFsScript('delete', '/persist/home/app', '/persist/home', '../x'));
  assert.throws(() =>
    buildFsScript('rename', '/persist/home/app', '/persist/home', 'a', '../../etc/x')
  );
});

test('fs scripts resolve paths in the box and refuse to leave the workspace through symlinks', (t) => {
  let hasGnu = false;
  try {
    sh('realpath -m / >/dev/null 2>&1 && mv --version >/dev/null 2>&1');
    hasGnu = true;
  } catch {
    hasGnu = false;
  }
  if (!hasGnu) {
    t.skip('needs GNU realpath and mv');
    return;
  }
  const tmp = sh('mktemp -d').trim();
  try {
    sh(
      `mkdir -p ${tmp}/home/ws/src ${tmp}/outside && echo x > ${tmp}/home/ws/src/a.txt && ln -s ${tmp}/outside ${tmp}/home/ws/link`
    );
    const run = (script: string): number => {
      try {
        execFileSync('/bin/sh', ['-c', script]);
        return 0;
      } catch (e: any) {
        return e.status;
      }
    };
    const root = `${tmp}/home/ws`;
    const guard = `${tmp}/home`;
    assert.equal(run(buildFsScript('mkdir', root, guard, 'src/new/dir')), 0);
    assert.equal(sh(`test -d ${root}/src/new/dir && echo yes`).trim(), 'yes');
    assert.equal(run(buildFsScript('mkdir', root, guard, 'src/new/dir')), FS_EXIT.exists);
    assert.equal(run(buildFsScript('mkdir', root, guard, 'link/escape')), FS_EXIT.outside);
    assert.equal(
      run(buildFsScript('rename', root, guard, 'src/a.txt', 'link/a.txt')),
      FS_EXIT.outside
    );
    assert.equal(run(buildFsScript('delete', root, guard, 'link/anything')), FS_EXIT.outside);
    assert.equal(run(buildFsScript('rename', root, guard, 'src/a.txt', 'docs/b.txt')), 0);
    assert.equal(sh(`cat ${root}/docs/b.txt`).trim(), 'x');
    assert.equal(run(buildFsScript('delete', root, guard, 'link')), 0);
    assert.equal(sh(`test -d ${tmp}/outside && echo kept`).trim(), 'kept');
    assert.equal(run(buildFsScript('delete', root, guard, 'missing')), FS_EXIT.missing);
    assert.equal(run(buildFsScript('delete', root, `${tmp}/elsewhere`, 'src')), FS_EXIT.outside);
  } finally {
    sh(`rm -rf ${tmp}`);
  }
});

test('ports come from /proc, filtered to dev processes, matched to the session worktree', () => {
  const out = [
    '@@listen@@',
    '00000000:0BB8 111',
    '0100007F:1435 222',
    '00000000:1771 333',
    '00000000000000000000000000000000:0BB8 444',
    '00000000:0016 555',
    '00000000:1F90 999',
    '@@sock@@',
    '/proc/10/fd socket:[111]',
    '/proc/10/fd socket:[444]',
    '/proc/11/fd socket:[222]',
    '/proc/12/fd socket:[333]',
    '/proc/13/fd socket:[555]',
    '@@proc@@',
    '10 /persist/home/.worktrees/app/fix node',
    '11 /persist/home/.worktrees/app/fix/web vite',
    '12 /persist/home/.worktrees/app/fixother python3',
    '13 /persist/home sshd'
  ].join('\n');
  assert.deepEqual(parsePortsOutput(out, '/persist/home/.worktrees/app/fix'), [
    { port: 3000, process: 'node', pid: 10, inSession: true, loopbackOnly: false },
    { port: 5173, process: 'vite', pid: 11, inSession: true, loopbackOnly: true },
    { port: 6001, process: 'python3', pid: 12, inSession: false, loopbackOnly: false }
  ]);
});

test('ports map a symlinked /persist back to the logical worktree path', () => {
  const out = [
    '@@home@@',
    '/vercel/sandbox/orchard/home',
    '@@listen@@',
    '00000000:0BB8 111',
    '00000000:0BB9 222',
    '@@sock@@',
    '/proc/10/fd socket:[111]',
    '/proc/11/fd socket:[222]',
    '@@proc@@',
    '10 /vercel/sandbox/orchard/home/.worktrees/app/fix/web node',
    '11 /vercel/sandbox/orchard/homework python3'
  ].join('\n');
  assert.deepEqual(
    parsePortsOutput(out, '/persist/home/.worktrees/app/fix').map((p) => [p.port, p.inSession]),
    [
      [3000, true],
      [3001, false]
    ]
  );
});

test('terminal commands attach to per-session tmux names and viewers are read-only', () => {
  const base = { sessionId: SID, worktreePath: '/persist/home/.worktrees/app/fix' };
  const rw = sandboxTerminalCommand({ ...base, index: '0', mode: 'rw' }, SID2).join(' ');
  assert.match(rw, /tmux -u new-session -A -s '\\''orchard-3f2d7e6a-0'\\''/);
  assert.match(rw, /exec su -l dev -c/);
  assert.doesNotMatch(rw, /attach-session -r/);
  const ro = sandboxTerminalCommand({ ...base, index: '1', mode: 'ro' }, SID2).join(' ');
  assert.match(ro, /attach-session -r -t '\\''=orchard-3f2d7e6a-1'\\''/);
  assert.doesNotMatch(ro, /new-session/);
  const setup = sandboxTerminalCommand({ ...base, index: 'setup', mode: 'ro' }, SID2).join(' ');
  assert.match(setup, /orchard-3f2d7e6a-setup/);
  assert.match(setup, /setup\.log/);
  const legacy = sandboxTerminalCommand(
    { sessionId: null, worktreePath: null, index: '0', mode: 'rw' },
    SID2
  ).join(' ');
  assert.match(legacy, new RegExp(`orchard-${SID2}`));
  assert.match(legacy, /cd '\\''\/persist\/home'\\''/);
  const evil = sandboxTerminalCommand(
    { sessionId: SID, worktreePath: "/tmp/x'; rm -rf /", index: '0', mode: 'rw' },
    SID2
  ).join(' ');
  assert.doesNotMatch(evil, /rm -rf/);
});

test('terminal query parsing validates sid, index and mode', () => {
  const q = (s: string) => parseSandboxTerminalQuery(new URLSearchParams(s));
  assert.deepEqual(q(''), { sessionId: null, index: '0', mode: 'rw' });
  assert.deepEqual(q(`sid=${SID}&n=2`), { sessionId: SID, index: '2', mode: 'rw' });
  assert.deepEqual(q(`sid=${SID}&n=setup`), { sessionId: SID, index: 'setup', mode: 'ro' });
  assert.deepEqual(q(`sid=${SID}&n=run&mode=rw`), { sessionId: SID, index: 'run', mode: 'rw' });
  assert.equal(q('sid=nope'), null);
  assert.equal(q(`sid=${SID}&n=../x`), null);
  assert.equal(q(`sid=${SID}&n=999`), null);
  assert.equal(q(`sid=${SID}&mode=admin`), null);
  assert.equal(q('n=3'), null);
  assert.equal(isTerminalIndex('setup'), true);
  assert.equal(isTerminalIndex('x'), false);
});

test('github helpers only accept well-formed owners and repos', () => {
  assert.deepEqual(parsePrUrl('https://github.com/acme/app/pull/12'), {
    owner: 'acme',
    repo: 'app',
    number: 12
  });
  assert.equal(parsePrUrl('https://evil.com/acme/app/pull/12'), null);
  assert.equal(parsePrUrl('https://github.com/ac%2fme/app/pull/12'), null);
  assert.deepEqual(parseGithubRemote('git@github.com:acme/app.git'), {
    owner: 'acme',
    repo: 'app'
  });
  assert.deepEqual(parseGithubRemote('https://github.com/acme/app\n'), {
    owner: 'acme',
    repo: 'app'
  });
  assert.equal(parseGithubRemote('https://gitlab.com/acme/app'), null);
  const fallback = { owner: 'acme', repo: 'app' };
  assert.deepEqual(parseIssueRef('#7', fallback), { owner: 'acme', repo: 'app', number: 7 });
  assert.deepEqual(parseIssueRef('o/r#3', null), { owner: 'o', repo: 'r', number: 3 });
  assert.deepEqual(parseIssueRef('https://github.com/o/r/issues/9', null), {
    owner: 'o',
    repo: 'r',
    number: 9
  });
  assert.equal(parseIssueRef('7', null), null);
  assert.equal(parseIssueRef('a b/r#1', null), null);
});

test('activity is working when any opencode session in the worktree is busy', () => {
  assert.equal(activityFromStatus({}), 'idle');
  assert.equal(activityFromStatus({ a: { type: 'idle' } }), 'idle');
  assert.equal(activityFromStatus({ a: { type: 'idle' }, b: { type: 'busy' } }), 'working');
  assert.equal(activityFromStatus({ a: { type: 'retry' } }), 'working');
  assert.equal(activityFromStatus(null), 'idle');
  const log = Array.from({ length: 100 }, (_, i) => `2026-10-08T10:00:00.0000000Z line ${i}`).join(
    '\n'
  );
  const excerpt = excerptLog(log);
  assert.equal(excerpt.split('\n').length, 60);
  assert.ok(excerpt.endsWith('line 99'));
  assert.ok(!excerpt.includes('2026-10-08T'));
});

test('declared ports widen the preview allowlist only inside the safe range', () => {
  assert.equal(isPreviewPortAllowed(5173), true);
  assert.equal(isPreviewPortAllowed(9229), false);
  assert.equal(isPreviewPortAllowed(9229, [9229]), true);
  for (const bad of [22, 80, 443, 1023, 2222, 4096, 65536]) {
    assert.equal(isPreviewPortAllowed(bad, [bad]), false, String(bad));
  }
  assert.equal(isPreviewPortCandidate(9229), true);
  assert.equal(isPreviewPortCandidate(4096), false);
  assert.equal(isPreviewPortCandidate(443), false);
  assert.deepEqual(
    declaredPreviewPorts({ declaredPorts: [9229, 22, 'x', 9229, 6006] }),
    [9229, 6006]
  );
  assert.deepEqual(declaredPreviewPorts(null), []);
  assert.deepEqual(mergeDeclaredPorts([6006], [9229, 3000, 6006]), [9229, 6006]);
  const many = mergeDeclaredPorts(
    Array.from({ length: 10 }, (_, i) => 20000 + i),
    [9229]
  );
  assert.equal(many.length, MAX_DECLARED_PREVIEW_PORTS);
  assert.equal(many[0], 9229);
});

test('declared ports get a per-machine NetworkPolicy from the kubernetes runner', async () => {
  const enqueued: any[] = [];
  const runner = new KubernetesSandboxRunner(
    { kc: {} } as never,
    {} as never,
    { get: async () => 'inst-1' } as never,
    { enqueue: async (item: any) => enqueued.push(item) } as never,
    { registerHandler: () => {} } as never,
    {} as never
  );
  const ref = {
    id: SID,
    userId: SID2,
    runner: 'kubernetes' as const,
    podName: `sbx-${SID}`,
    namespace: null,
    externalId: null,
    runnerState: null
  };
  await runner.requestPreviewPorts(ref, [9229, 4096]);
  assert.equal(enqueued.length, 1);
  const item = enqueued[0];
  assert.equal(item.opType, 'ssa');
  assert.equal(item.dedupeKey, `sandbox:${SID}:preview-netpol`);
  assert.equal(item.sandboxId, SID);
  assert.equal(item.manifest.kind, 'NetworkPolicy');
  assert.equal(item.manifest.metadata.name, `sbx-${SID}-previews`);
  assert.deepEqual(item.manifest.spec.podSelector, {
    matchLabels: { 'orchard.my/sandbox-id': SID }
  });
  assert.deepEqual(item.manifest.spec.policyTypes, ['Ingress']);
  assert.deepEqual(item.manifest.spec.ingress[0].ports, [{ port: 9229, protocol: 'TCP' }]);
  assert.equal(item.manifest.metadata.labels['orchard.my/instance'], 'inst-1');
  await runner.requestPreviewPorts(ref, [22, 4096]);
  assert.equal(enqueued.length, 1);
});

test('GET ports lists declared ports before anything listens and records them', async () => {
  const updates: any[] = [];
  const policies: number[][] = [];
  let state: any = { secretHash: 'h' };
  const prisma = {
    sandboxConversation: {
      findFirst: async () => ({
        id: SID2,
        sandboxId: SID,
        repo: 'app',
        slug: 'fix',
        worktreePath: '/persist/home/.worktrees/app/fix',
        archivedAt: null
      })
    },
    sandbox: {
      findUnique: async () => ({ runnerState: state }),
      updateMany: async (args: any) => {
        updates.push(args);
        state = args.data.runnerState;
        return { count: 1 };
      }
    }
  };
  const runner = {
    id: 'kubernetes',
    capabilities: { previews: 'proxy' },
    exec: async (_ref: unknown, cmd: string[]) => {
      const script = cmd[cmd.length - 1];
      if (script.includes('@@listen@@')) {
        return {
          ok: true,
          exitCode: 0,
          stderr: '',
          stdout: [
            '@@listen@@',
            '00000000:0BB8 111',
            '@@sock@@',
            '/proc/10/fd socket:[111]',
            '@@proc@@',
            '10 /persist/home/.worktrees/app/fix node'
          ].join('\n')
        };
      }
      const nonce = script.match(/@@([0-9a-f]+):config@@/)![1];
      return {
        ok: true,
        exitCode: 0,
        stderr: '',
        stdout: `@@${nonce}:config@@\n{"ports":[3000,9229,4096]}\n@@${nonce}:setup@@\n\n@@${nonce}:run@@\n`
      };
    },
    requestPreviewPorts: async (_ref: unknown, ports: number[]) => {
      policies.push(ports);
    }
  };
  const svc = new SandboxSessionsService(
    prisma as never,
    { for: () => runner } as never,
    {} as never,
    {} as never
  );
  const sandbox = {
    id: SID,
    userId: SID2,
    runner: 'kubernetes',
    podName: `sbx-${SID}`,
    namespace: null,
    externalId: null,
    runnerState: state,
    status: 'running',
    repoUrl: null
  };
  const { ports } = await svc.ports(sandbox as never, SID2);
  assert.deepEqual(
    ports.map((p) => [p.port, p.listening, p.declared, p.process]),
    [
      [3000, true, true, 'node'],
      [9229, false, true, null]
    ]
  );
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(state.declaredPorts, [9229]);
  assert.equal(state.secretHash, 'h');
  assert.deepEqual(policies, [[9229]]);
  await svc.recordDeclaredPorts(sandbox as never, [9229]);
  assert.equal(updates.length, 1);
});

function hookRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-coauthor-'));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Hana Host',
    GIT_AUTHOR_EMAIL: 'host@example.com',
    GIT_COMMITTER_NAME: 'Hana Host',
    GIT_COMMITTER_EMAIL: 'host@example.com',
    GIT_CONFIG_GLOBAL: join(dir, 'gitconfig'),
    HOME: dir
  };
  writeFileSync(join(dir, 'gitconfig'), '');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env, encoding: 'utf8' });
  const repo = join(dir, 'repo');
  execFileSync('git', ['init', '-q', '-b', 'main', repo], { env });
  writeFileSync(join(repo, 'a'), '1');
  git(repo, 'add', 'a');
  git(repo, 'commit', '-qm', 'init');
  mkdirSync(join(repo, '.husky'));
  writeFileSync(
    join(repo, '.husky', 'commit-msg'),
    '#!/bin/sh\necho "husky ran" >> "$(git rev-parse --git-common-dir)/../husky.log"\n'
  );
  chmodSync(join(repo, '.husky', 'commit-msg'), 0o755);
  git(repo, 'add', '.husky');
  git(repo, 'commit', '-qm', 'hooks');
  git(repo, 'config', 'core.hooksPath', '.husky');
  const wt = join(dir, 'wt');
  git(repo, 'worktree', 'add', '-q', '-b', 'orchard/fix', wt);
  const state = join(dir, 'state');
  const hooks = join(state, 'hooks');
  mkdirSync(hooks, { recursive: true });
  writeFileSync(join(hooks, 'orchard-hook'), COAUTHOR_HOOK_SCRIPT);
  chmodSync(join(hooks, 'orchard-hook'), 0o755);
  for (const name of COAUTHOR_HOOK_NAMES) symlinkSync('orchard-hook', join(hooks, name));
  git(wt, 'config', 'extensions.worktreeConfig', 'true');
  git(wt, 'config', '--worktree', 'core.hooksPath', hooks);
  return { dir, repo, wt, state, git };
}

test('the co-author hook adds the turn authors, keeps the repo hooks and skips the committer', () => {
  const { dir, repo, wt, state, git } = hookRepo();
  try {
    writeFileSync(
      join(state, 'coauthors'),
      'Gus Guest <2002+gus@users.noreply.github.com>\nHana Host <host@example.com>\nnot a line\n'
    );
    writeFileSync(join(wt, 'b'), '2');
    git(wt, 'add', 'b');
    git(wt, 'commit', '-qm', 'agent change');
    const body = git(wt, 'log', '-1', '--format=%B');
    assert.match(
      body,
      /^agent change\n\nCo-authored-by: Gus Guest <2002\+gus@users\.noreply\.github\.com>\n/
    );
    assert.doesNotMatch(body, /Hana Host/);
    assert.doesNotMatch(body, /not a line/);
    assert.match(readFileSync(join(repo, 'husky.log'), 'utf8'), /husky ran/);

    writeFileSync(join(wt, 'c'), '3');
    git(wt, 'add', 'c');
    git(wt, 'commit', '-qm', 'ui commit\n\nCo-authored-by: Gus Guest <gus@example.com>');
    const second = git(wt, 'log', '-1', '--format=%B');
    assert.equal((second.match(/Co-authored-by/g) ?? []).length, 1, 'no duplicate by name');

    writeFileSync(join(state, 'coauthors'), '');
    writeFileSync(join(repo, 'd'), '4');
    git(repo, 'add', 'd');
    git(repo, 'commit', '-qm', 'main checkout');
    assert.doesNotMatch(git(repo, 'log', '-1', '--format=%B'), /Co-authored-by/);
    assert.equal(git(repo, 'config', '--get', 'core.hooksPath').trim(), '.husky');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('co-author list updates reset on a new turn and append while the agent works', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-coauthor-list-'));
  try {
    const local = (script: string) => script.split(sessionStateDir(SID)).join(join(dir, 'state'));
    const run = (mode: 'reset' | 'append', line: string) =>
      execFileSync('/bin/sh', ['-c', local(buildCoauthorUpdate(SID, mode))], {
        input: `${line}\n`
      });
    const list = () => readFileSync(join(dir, 'state', 'coauthors'), 'utf8');
    run('reset', 'Gus <g@x.dev>');
    run('append', 'Ann <a@x.dev>');
    run('append', 'Gus <g@x.dev>');
    assert.equal(list(), 'Gus <g@x.dev>\nAnn <a@x.dev>\n');
    run('reset', 'Ann <a@x.dev>');
    assert.equal(list(), 'Ann <a@x.dev>\n');
    run('reset', '');
    assert.equal(list(), '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const install = buildCoauthorHookInstall(SID, '/persist/home/.worktrees/app/fix');
  assert.match(install, /config extensions\.worktreeConfig true/);
  assert.match(
    install,
    /config --worktree core\.hooksPath '\/persist\/home\/\.orchard\/sessions\/3f2d7e6a-1b0c-4d5e-8f90-123456789abc\/hooks'/
  );
  assert.match(install, /cat > /);
  assert.match(install, /prepare-commit-msg/);
  assert.doesNotMatch(install, /: > /, 'install never clears the list');
  assert.throws(() => buildCoauthorHookInstall(SID, '/persist/home/.ssh'), /invalid worktree/);
  assert.equal(coauthorLine({ name: 'Gus <x>', email: 'g@x.dev' }), null);
  assert.equal(coauthorLine({ name: 'Gus', email: 'not-an-email' }), null);
  assert.equal(coauthorLine({ name: ' Gus  Guest ', email: 'g@x.dev' }), 'Gus Guest <g@x.dev>');
  assert.match(COAUTHOR_HOOK_SCRIPT, /interpret-trailers --in-place --if-exists addIfDifferent/);
});

test('a prompt picks the co-author list mode from the agent status and skips the host', async () => {
  const HOST = SID2;
  const GUEST = 'cccccccc-1b0c-4d5e-8f90-123456789abc';
  let status: any = {};
  const writes: Array<{ script: string; stdin: string }> = [];
  const prisma = {
    sandboxConversation: {
      findFirst: async () => ({
        id: SID,
        worktreePath: '/persist/home/.worktrees/app/fix',
        archivedAt: null
      })
    },
    sandbox: {
      findUnique: async () => ({
        id: 'box',
        userId: HOST,
        runner: 'kubernetes',
        podName: 'sbx-box',
        namespace: null,
        externalId: null,
        runnerState: null,
        status: 'running',
        repoUrl: null
      })
    }
  };
  const workspace = {
    opencodeRequest: async (_s: unknown, _m: string, path: string) => {
      assert.equal(path, '/session/status');
      return { status: 200, body: status };
    },
    runIn: async (_s: unknown, _d: string, _g: unknown, script: string, opts: any) => {
      writes.push({ script, stdin: opts.stdin.toString() });
      return { ok: true, exitCode: 0, stdout: '' };
    }
  };
  const actors = {
    describe: async () => ({ name: 'Gus Guest', email: '2002+gus@users.noreply.github.com' })
  };
  let listener: any = null;
  const members = { setPromptListener: (fn: any) => (listener = fn) };
  const svc = new SandboxCoauthorsService(
    prisma as never,
    workspace as never,
    actors as never,
    members as never
  );
  assert.ok(listener, 'registers on the members service');
  const base = { sandboxId: 'box', sessionKey: SID, chatId: 'ses_abc', messageId: 'msg_1' };
  const idle = await svc.onPrompt({ ...base, userId: GUEST });
  await idle?.written;
  assert.equal(idle?.mode, 'reset');
  assert.equal(writes[0].stdin, 'Gus Guest <2002+gus@users.noreply.github.com>\n');
  assert.match(writes[0].script, /> '\/persist\/home\/\.orchard\/sessions\/[^']+\/coauthors'/);
  status = { ses_abc: { type: 'busy' } };
  const busy = await svc.onPrompt({ ...base, userId: GUEST });
  assert.equal(busy?.mode, 'append');
  assert.equal(
    await svc.onPrompt({ ...base, userId: HOST }),
    null,
    'host joining a turn is a no-op'
  );
  status = {};
  const hostTurn = await svc.onPrompt({ ...base, userId: HOST });
  await hostTurn?.written;
  assert.equal(hostTurn?.mode, 'reset');
  assert.equal(writes[writes.length - 1].stdin, '\n');
  assert.equal(await svc.onPrompt({ ...base, sessionKey: null, userId: GUEST }), null);
});

test('the first prompt of a new session is attributed to its creator with a message id', async () => {
  const recorded: any[] = [];
  const sent: any[] = [];
  const execs: string[] = [];
  const row = {
    id: SID,
    sandboxId: 'box',
    title: 'Fix login',
    slug: 'fix-login-abc123',
    repo: 'app',
    branch: 'orchard/fix-login-abc123',
    worktreePath: '/persist/home/.worktrees/app/fix-login-abc123',
    createdById: SID2,
    archivedAt: null,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const prisma = {
    sandboxConversation: {
      create: async () => row,
      update: async (args: any) => ({ ...row, ...args.data, createdBy: null })
    }
  };
  const registry = {
    for: () => ({
      exec: async (_ref: unknown, cmd: string[]) => {
        execs.push(cmd[cmd.length - 1]);
        return {
          ok: true,
          exitCode: 0,
          stderr: '',
          stdout: '@@base@@main\n@@commit@@abcdef1\n'
        };
      },
      writeFiles: async () => {}
    })
  };
  const workspace = {
    opencodeRequest: async (_s: unknown, method: string, path: string, opts: any) => {
      if (path === '/session') return { status: 200, body: { id: 'ses_first' } };
      sent.push({ method, path, opts });
      return { status: 204, body: null };
    }
  };
  const members = {
    recordPrompt: async (input: any) => {
      recorded.push(input);
      return true;
    }
  };
  const svc = new SandboxSessionsService(
    prisma as never,
    registry as never,
    workspace as never,
    {} as never
  );
  new SandboxAgentService({} as never, workspace as never, members as never, svc);
  const sandbox = {
    id: 'box',
    userId: SID2,
    runner: 'kubernetes',
    podName: 'sbx-box',
    namespace: null,
    externalId: null,
    runnerState: null,
    status: 'running',
    repoUrl: null
  };
  const dto = await svc.create(sandbox as never, SID2, { repo: 'app', prompt: 'Fix the login' });
  assert.equal(dto.activity, 'working');
  for (let i = 0; i < 20 && !sent.length; i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].userId, SID2);
  assert.equal(recorded[0].chatId, 'ses_first');
  assert.match(recorded[0].messageId, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.equal(sent[0].path, '/session/ses_first/prompt_async');
  assert.equal(sent[0].opts.body.messageID, recorded[0].messageId);
  assert.ok(
    execs.some((script) => script.includes('core.hooksPath')),
    'co-author hook installed before the prompt'
  );
});

function realpathShim(dir: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, 'realpath'),
    [
      '#!/usr/bin/env python3',
      'import os, sys',
      'args = [a for a in sys.argv[1:] if a != "--"]',
      'paths = [a for a in args if not a.startswith("-")]',
      'p = os.path.realpath(paths[0])',
      'if "-e" in args and not os.path.exists(p): sys.exit(1)',
      'print(p)'
    ].join('\n')
  );
  chmodSync(join(bin, 'realpath'), 0o755);
  return bin;
}

test('viewer file reads stay inside the workspace even through symlinks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orchard-confine-'));
  try {
    const home = join(dir, 'home');
    const wt = join(home, '.worktrees', 'app', 'fix');
    mkdirSync(join(home, 'app', 'src'), { recursive: true });
    mkdirSync(join(home, '.config', 'orchard'), { recursive: true });
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(home, '.git-credentials'), 'https://x:ghp_secret@github.com');
    writeFileSync(join(home, '.config', 'orchard', 'env'), 'TOKEN=secret');
    writeFileSync(join(home, 'notes.txt'), 'notes');
    writeFileSync(join(home, 'app', 'src', 'a.txt'), 'hello');
    writeFileSync(join(wt, 'b.txt'), 'worktree');
    symlinkSync(join(home, '.git-credentials'), join(home, 'app', 'creds'));
    symlinkSync(join(home, '.config'), join(home, 'app', 'cfg'));
    symlinkSync('/etc', join(home, 'app', 'sys'));
    symlinkSync(join(home, '.git-credentials'), join(wt, 'leak'));
    symlinkSync(join(home, '.config'), join(home, 'evil'));
    const bin = realpathShim(dir);
    const local = (script: string) => script.split(HOME_ROOT).join(home);
    const run = (script: string): { code: number; out: string } => {
      try {
        const out = execFileSync('/bin/sh', ['-c', local(script)], {
          encoding: 'utf8',
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
        });
        return { code: 0, out };
      } catch (e: any) {
        return { code: e.status, out: '' };
      }
    };
    const read = (root: string, file: string) => {
      const r = run(buildConfinedReadScript(root, file, 1000));
      return r.code === 0 ? Buffer.from(r.out.trim(), 'base64').toString('utf8') : r.code;
    };
    const app = `${HOME_ROOT}/app`;
    assert.equal(read(app, 'src/a.txt'), 'hello');
    assert.equal(read(app, 'creds'), READ_EXIT.outside);
    assert.equal(read(app, 'cfg/orchard/env'), READ_EXIT.outside);
    assert.equal(read(app, 'sys/hosts'), READ_EXIT.outside);
    assert.equal(read(app, 'missing.txt'), READ_EXIT.missing);
    assert.equal(read(app, 'src'), READ_EXIT.notFile);
    assert.equal(read(HOME_ROOT, 'notes.txt'), 'notes');
    assert.equal(read(HOME_ROOT, '.git-credentials'), READ_EXIT.outside);
    assert.equal(read(HOME_ROOT, '.config/orchard/env'), READ_EXIT.outside);
    assert.equal(read(`${HOME_ROOT}/evil`, 'orchard/env'), READ_EXIT.outside);
    const worktree = `${HOME_ROOT}/.worktrees/app/fix`;
    assert.equal(read(worktree, 'b.txt'), 'worktree');
    assert.equal(read(worktree, 'leak'), READ_EXIT.outside);
    assert.throws(() => buildConfinedReadScript(app, '../.git-credentials', 10));
    assert.throws(() => buildConfinedReadScript(app, '.git/config', 10));

    const check = (root: string, file: string) => run(buildConfinedPathCheck(root, file)).code;
    assert.equal(check(app, 'src/new.txt'), 0);
    assert.equal(check(app, 'cfg/new.txt'), READ_EXIT.outside);
    assert.equal(check(app, 'creds'), READ_EXIT.outside);
    assert.equal(check(HOME_ROOT, '.ssh/id_ed25519'), READ_EXIT.outside);

    const del = run(buildFsScript('delete', HOME_ROOT, HOME_ROOT, '.git-credentials')).code;
    assert.equal(del, FS_EXIT.outside, 'home dotfiles cannot be renamed or deleted');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('GET file and diff run the confinement in the box and map its refusal', async () => {
  const execs: string[] = [];
  let exitCode = READ_EXIT.outside;
  const registry = {
    for: () => ({
      exec: async (_ref: unknown, cmd: string[]) => {
        execs.push(cmd[cmd.length - 1]);
        return {
          ok: exitCode === 0,
          exitCode,
          stdout: exitCode === 0 ? Buffer.from('hi').toString('base64') : '',
          stderr: ''
        };
      }
    })
  };
  const svc = new SandboxWorkspaceService(registry as never, {} as never, {} as never);
  const box = {
    id: 'box',
    userId: SID2,
    runner: 'kubernetes',
    podName: 'sbx-box',
    namespace: null,
    externalId: null,
    runnerState: null,
    status: 'running',
    repoUrl: null
  };
  await assert.rejects(() => svc.readFile(box as never, 'app', 'creds'), /outside the workspace/);
  assert.match(execs[0], /realpath -e -- "\$__root"\/'creds'/);
  exitCode = 0;
  assert.deepEqual(await svc.readFile(box as never, 'app', 'src/a.txt'), {
    content: 'hi',
    truncated: false
  });
  exitCode = READ_EXIT.outside;
  await assert.rejects(() => svc.diff(box as never, 'cfg/x', 'app'), /outside the workspace/);
  assert.match(execs.at(-1)!, /realpath -m -- "\$__root"\/'cfg\/x'/);
});
