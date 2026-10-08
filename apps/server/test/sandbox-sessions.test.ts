import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'child_process';
import {
  FS_EXIT,
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
      '{"setup":"pnpm i","run":["pnpm dev","echo hi"],"ports":[3000,"5173",0,70000,3000,"x"]}'
    ),
    { setup: 'pnpm i', run: 'pnpm dev\necho hi', ports: [3000, 5173] }
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
  assert.equal(many.ports.length, 20);
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
