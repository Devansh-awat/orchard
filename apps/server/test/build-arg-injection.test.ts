import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { injectBuildArgsScript, buildArgDeclarations } from '../src/docker/build-args';

/**
 * The build job used to rewrite every Dockerfile with `ARG X` *and*
 * `ENV X=${X}`. The ENV half did nothing at build time — ARG already exposes a
 * build arg to RUN — and wrote every value into the pushed image's config,
 * where a `docker inspect` by anyone who can pull it reads back the plaintext.
 * It also kept variables alive in the image after they were deleted from the
 * config, which is how an API key stayed in a container its owner had removed
 * it from.
 *
 * These run the real init-container script, not a description of it.
 */

const KEYS = ['DATABASE_URL', 'OPENAI_API_KEY', 'REVIEW_IDS'];

/** Run the generated script over a Dockerfile and hand back the rewrite. */
function inject(
  dockerfile: string,
  opts: { keys?: string[]; dockerfilePath?: string } = {}
): string {
  const workspace = mkdtempSync(join(tmpdir(), 'orchard-buildargs-'));
  const dockerfilePath = opts.dockerfilePath ?? 'Dockerfile';
  try {
    const target = join(workspace, dockerfilePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, dockerfile);
    execFileSync(
      '/bin/sh',
      ['-c', injectBuildArgsScript({ dockerfilePath, keys: opts.keys ?? KEYS })],
      { env: { ...process.env, WORKSPACE: workspace }, stdio: 'pipe' }
    );
    return readFileSync(target, 'utf8');
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

const SINGLE_STAGE = `FROM node:20-alpine
WORKDIR /app
COPY . .
RUN npm ci && npm run build
CMD ["node", "server.js"]
`;

test('no ENV directive is written into the image', () => {
  const out = inject(SINGLE_STAGE);

  const envLines = out.split('\n').filter((l) => /^ENV\b/.test(l.trim()));
  assert.deepEqual(envLines, [], `injection emitted ENV directives: ${envLines.join(' | ')}`);
});

test('the values themselves never touch the Dockerfile', () => {
  // Values are passed to the builder as --build-arg; only the names belong in
  // the file. A value landing here would end up in the build context and logs.
  const out = inject(SINGLE_STAGE);

  for (const key of KEYS) {
    assert.ok(out.includes(`ARG ${key}`), `missing ARG for ${key}`);
    assert.ok(
      !out.includes(`${key}=`),
      `${key} appears as an assignment, which bakes it into a layer`
    );
  }
});

test('RUN steps can still read the variables', () => {
  const out = inject(SINGLE_STAGE);
  const lines = out.split('\n').map((l) => l.trim());

  const from = lines.findIndex((l) => l.startsWith('FROM '));
  const run = lines.findIndex((l) => l.startsWith('RUN '));
  for (const key of KEYS) {
    const arg = lines.indexOf(`ARG ${key}`);
    assert.ok(arg > from, `ARG ${key} must sit inside the stage, not above it`);
    assert.ok(arg < run, `ARG ${key} must precede the RUN steps that read it`);
  }
});

test("the user's own Dockerfile is otherwise untouched", () => {
  const dockerfile = `FROM node:20-alpine
ENV NODE_ENV=production
ARG MY_OWN_ARG
WORKDIR /app
RUN npm ci
CMD ["node", "server.js"]
`;
  const out = inject(dockerfile);

  // Their ENV stays; we simply stop adding our own.
  assert.ok(out.includes('ENV NODE_ENV=production'), "clobbered the user's ENV");
  assert.ok(out.includes('ARG MY_OWN_ARG'), "clobbered the user's ARG");
  for (const line of ['WORKDIR /app', 'RUN npm ci', 'CMD ["node", "server.js"]']) {
    assert.ok(out.includes(line), `dropped ${line}`);
  }
});

test('a multi-stage build keeps its later stages intact', () => {
  const dockerfile = `FROM node:20-alpine AS builder
WORKDIR /app
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
`;
  const out = inject(dockerfile);

  assert.ok(out.includes('FROM nginx:alpine'), 'lost the runtime stage');
  assert.ok(
    out.includes('COPY --from=builder /app/dist /usr/share/nginx/html'),
    'lost the artifact copy'
  );
  const envLines = out.split('\n').filter((l) => /^ENV\b/.test(l.trim()));
  assert.deepEqual(envLines, [], 'multi-stage build still got baked ENV directives');
});

test('a Dockerfile in a subdirectory is found', () => {
  const out = inject(SINGLE_STAGE, { dockerfilePath: 'apps/api/Dockerfile' });
  assert.ok(out.includes('ARG DATABASE_URL'));
});

test('a missing Dockerfile fails the build instead of silently continuing', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'orchard-buildargs-'));
  try {
    assert.throws(() =>
      execFileSync(
        '/bin/sh',
        ['-c', injectBuildArgsScript({ dockerfilePath: 'Dockerfile', keys: KEYS })],
        { env: { ...process.env, WORKSPACE: workspace }, stdio: 'pipe' }
      )
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test('declarations are ARG-only at the string level too', () => {
  const declarations = buildArgDeclarations(['A', 'B']);
  assert.equal(declarations, 'ARG A\nARG B');
});
