import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REPO_PATH_EXIT,
  buildCloneToLocationScript,
  buildInitAtLocationScript,
  buildLinkFolderScript,
  buildListDirsScript,
  normalizeMachinePath,
  parseDirListing,
  printedKey,
  printedTop,
  repoKeyBase
} from '../server/src/sandboxes/sandbox-repo-paths';
import {
  READ_EXIT,
  buildFsScript,
  buildRepoRemoveScript
} from '../server/src/sandboxes/sandbox-session-commands';

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null'
};

function sandbox() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gh-paths-')));
  const home = join(root, 'home');
  const work = join(root, 'work');
  mkdirSync(home);
  mkdirSync(work);
  return { root, home, work, done: () => rmSync(root, { recursive: true, force: true }) };
}

function sh(script: string) {
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV }
  });
  return { code: r.status, stdout: r.stdout + r.stderr };
}

function git(dir: string, ...args: string[]) {
  return spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV }
  });
}

test('machine paths are absolute, normalised and expand ~', () => {
  assert.equal(normalizeMachinePath('/srv/work/'), '/srv/work');
  assert.equal(normalizeMachinePath('/srv/./a/../b'), '/srv/b');
  assert.equal(normalizeMachinePath('~'), '/persist/home');
  assert.equal(normalizeMachinePath('~/code/app'), '/persist/home/code/app');
  assert.equal(normalizeMachinePath('/'), '/');
  for (const bad of ['', 'relative', '~user/x', 'a\nb', '/x\0', 42, null, '/'.repeat(2000)]) {
    assert.equal(normalizeMachinePath(bad), null, JSON.stringify(bad));
  }
});

test('repo keys come from the folder name and stay valid repo names', () => {
  assert.equal(repoKeyBase('/srv/work/api'), 'api');
  assert.equal(repoKeyBase('/srv/My Project!'), 'My-Project');
  assert.equal(repoKeyBase('/srv/.hidden'), 'hidden');
  assert.equal(repoKeyBase('/srv/x.lock'), 'x');
  assert.equal(repoKeyBase('/srv/a..b'), 'a.b');
  assert.equal(repoKeyBase('/srv/日本'), 'project');
  assert.equal(printedKey('noise\nKEY:api-2\n'), 'api-2');
  assert.equal(printedKey('KEY:../etc'), null);
  assert.equal(printedTop('TOP:/srv/mono\n'), '/srv/mono');
});

test('new projects anywhere are created, committed and linked into home', () => {
  const s = sandbox();
  try {
    const r = sh(buildInitAtLocationScript(join(s.work, 'nested'), 'app', s.home));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(printedKey(r.stdout), 'app');
    const target = join(s.work, 'nested', 'app');
    assert.equal(readlinkSync(join(s.home, 'app')), target);
    assert.equal(git(target, 'log', '--oneline').stdout.trim().split('\n').length, 1);

    mkdirSync(join(s.work, 'other'));
    const second = sh(buildInitAtLocationScript(join(s.work, 'other'), 'app', s.home));
    assert.equal(second.code, 0, second.stdout);
    assert.equal(printedKey(second.stdout), 'app-2');

    const again = sh(buildInitAtLocationScript(join(s.work, 'nested'), 'app', s.home));
    assert.equal(again.code, REPO_PATH_EXIT.exists);

    const home = sh(buildInitAtLocationScript(s.home, 'plain', s.home));
    assert.equal(home.code, 0, home.stdout);
    assert.equal(lstatSync(join(s.home, 'plain')).isSymbolicLink(), false);
  } finally {
    s.done();
  }
});

test('locations inside hidden home folders and system paths are refused', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, '.ssh'));
    for (const location of [join(s.home, '.ssh'), '/proc', '/', '/dev/shm']) {
      const r = sh(buildInitAtLocationScript(location, 'x', s.home));
      assert.equal(r.code, REPO_PATH_EXIT.forbidden, `${location}: ${r.stdout}`);
    }
    symlinkSync(join(s.home, '.ssh'), join(s.work, 'sneaky'));
    const r = sh(buildLinkFolderScript(join(s.work, 'sneaky'), s.home));
    assert.equal(r.code, REPO_PATH_EXIT.forbidden, r.stdout);
  } finally {
    s.done();
  }
});

test('opening a plain folder initialises it with its files and links it', () => {
  const s = sandbox();
  try {
    const dir = join(s.work, 'My App');
    mkdirSync(dir);
    writeFileSync(join(dir, 'index.js'), 'console.log(1)\n');
    const r = sh(buildLinkFolderScript(dir, s.home));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(printedKey(r.stdout), 'My-App');
    assert.equal(readlinkSync(join(s.home, 'My-App')), dir);
    assert.equal(git(dir, 'ls-files').stdout.trim(), 'index.js');

    const twice = sh(buildLinkFolderScript(dir, s.home));
    assert.equal(twice.code, REPO_PATH_EXIT.alreadyProject);
    assert.equal(printedKey(twice.stdout), 'My-App');
  } finally {
    s.done();
  }
});

test('opening an existing repo keeps its history and does not commit', () => {
  const s = sandbox();
  try {
    const dir = join(s.work, 'repo');
    mkdirSync(dir);
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'a'), 'a');
    git(dir, 'add', 'a');
    git(dir, 'commit', '-qm', 'first');
    writeFileSync(join(dir, 'b'), 'dirty');
    const r = sh(buildLinkFolderScript(dir, s.home));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(git(dir, 'rev-list', '--count', 'HEAD').stdout.trim(), '1');
    assert.equal(git(dir, 'status', '--porcelain').stdout.trim(), '?? b');
  } finally {
    s.done();
  }
});

test('a folder inside a repo points at the repo root', () => {
  const s = sandbox();
  try {
    const mono = join(s.work, 'mono');
    mkdirSync(join(mono, 'apps', 'web'), { recursive: true });
    git(mono, 'init', '-q');
    const r = sh(buildLinkFolderScript(join(mono, 'apps', 'web'), s.home));
    assert.equal(r.code, REPO_PATH_EXIT.insideRepo);
    assert.equal(printedTop(r.stdout), mono);
    assert.equal(existsSync(join(s.home, 'web')), false);
  } finally {
    s.done();
  }
});

test('a folder already in home is opened in place without a link', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.home, 'notes'));
    const r = sh(buildLinkFolderScript(join(s.home, 'notes'), s.home));
    assert.equal(r.code, 0, r.stdout);
    assert.equal(printedKey(r.stdout), 'notes');
    assert.equal(lstatSync(join(s.home, 'notes')).isSymbolicLink(), false);
    assert.ok(existsSync(join(s.home, 'notes', '.git')));
  } finally {
    s.done();
  }
});

test('cloning to a location lands the repo there and links it once it finishes', async () => {
  const s = sandbox();
  try {
    const origin = join(s.root, 'origin');
    mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    git(origin, 'commit', '-q', '--allow-empty', '-m', 'init');
    const r = sh(
      buildCloneToLocationScript({
        location: join(s.work, 'clones'),
        name: 'origin',
        git: 'git',
        url: `file://${origin}`,
        preflightSeconds: 10,
        home: s.home
      })
    );
    assert.equal(r.code, 0, r.stdout);
    assert.equal(printedKey(r.stdout), 'origin');
    const link = join(s.home, 'origin');
    for (let i = 0; i < 100 && !existsSync(link); i++) await new Promise((d) => setTimeout(d, 50));
    assert.equal(readlinkSync(link), join(s.work, 'clones', 'origin'));
    assert.ok(existsSync(join(link, '.git')));

    const missing = sh(
      buildCloneToLocationScript({
        location: s.work,
        name: 'nope',
        git: 'git',
        url: `file://${s.root}/nope`,
        preflightSeconds: 10,
        home: s.home
      })
    );
    assert.equal(missing.code, 13);
  } finally {
    s.done();
  }
});

test('folders list with a git marker, hidden ones left out', () => {
  const s = sandbox();
  try {
    mkdirSync(join(s.work, 'b'));
    mkdirSync(join(s.work, 'a'));
    mkdirSync(join(s.work, '.cache'));
    writeFileSync(join(s.work, 'file'), '');
    git(join(s.work, 'b'), 'init', '-q');
    const r = sh(buildListDirsScript(s.work));
    assert.equal(r.code, 0, r.stdout);
    const listing = parseDirListing(r.stdout);
    assert.deepEqual(listing, {
      path: s.work,
      parent: s.root,
      git: false,
      entries: [
        { name: 'a', path: join(s.work, 'a'), git: false },
        { name: 'b', path: join(s.work, 'b'), git: true }
      ],
      truncated: false
    });
    assert.equal(sh(buildListDirsScript(join(s.work, 'gone'))).code, REPO_PATH_EXIT.missing);
    assert.equal(sh(buildListDirsScript(join(s.work, 'file'))).code, REPO_PATH_EXIT.notDirectory);
  } finally {
    s.done();
  }
});

test('file operations work on a linked repo outside home and nowhere else', () => {
  const s = sandbox();
  try {
    const dir = join(s.work, 'api');
    mkdirSync(dir);
    git(dir, 'init', '-q');
    symlinkSync(dir, join(s.home, 'api'));
    const ok = sh(buildFsScript('mkdir', join(s.home, 'api'), s.home, 'src', undefined, s.home));
    assert.equal(ok.code, 0, ok.stdout);
    assert.ok(existsSync(join(dir, 'src')));

    const plain = join(s.work, 'plain');
    mkdirSync(plain);
    symlinkSync(plain, join(s.home, 'plain'));
    const refused = sh(
      buildFsScript('mkdir', join(s.home, 'plain'), s.home, 'x', undefined, s.home)
    );
    assert.equal(refused.code, READ_EXIT.outside);

    const nested = join(s.home, 'deep');
    mkdirSync(nested);
    symlinkSync(dir, join(nested, 'api'));
    const deep = sh(buildFsScript('mkdir', join(nested, 'api'), s.home, 'y', undefined, s.home));
    assert.equal(deep.code, READ_EXIT.outside);
  } finally {
    s.done();
  }
});

test('removing a linked repo unlinks it and leaves the folder alone', () => {
  const script = buildRepoRemoveScript('api');
  assert.match(script, /if \[ -L '\/persist\/home\/api' \]/);
  assert.match(script, /rm -f -- '\/persist\/home\/api'/);
  assert.match(script, /worktree prune/);
});
