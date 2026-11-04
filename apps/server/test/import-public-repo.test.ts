import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { GitHubService } from '../src/github/github.service';
import { ProjectsController } from '../src/projects/projects.controller';
import { SecretCryptoService } from '../src/crypto/secret-crypto.service';
import { detectedBuildFor } from '../src/projects/detected-build';

const tree = { tree: [{ type: 'blob', path: 'Dockerfile' }] };
const dockerfile = 'FROM nginx\nEXPOSE 3000\n';

function stubGitHub() {
  const auth: (string | null)[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init: any) => {
    auth.push(init?.headers?.Authorization ?? null);
    const url = String(input);
    if (url.includes('/git/trees/')) return new Response(JSON.stringify(tree));
    if (url.includes('/contents/Dockerfile')) return new Response(dockerfile);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { auth, restore: () => (globalThis.fetch = original) };
}

function github() {
  return new GitHubService({} as any, {} as any, {} as any, {} as any, new SecretCryptoService());
}

test('a public repo is detected with no token and sends no credentials', async () => {
  const { auth, restore } = stubGitHub();
  try {
    const det = await github().detectRepoConfig(null, 'docker', 'welcome-to-docker', 'main');
    assert.equal(det.buildType, 'dockerfile');
    assert.equal(det.dockerfilePath, 'Dockerfile');
    assert.deepEqual(det.ports, [3000]);
    assert.ok(auth.length > 0);
    assert.ok(auth.every((header) => header === null));
  } finally {
    restore();
  }
});

function controller(token: string | null) {
  const created: { deployment?: any } = {};
  const service = Object.create(ProjectsController.prototype) as any;
  service.githubService = {
    parseRepoUrl: () => ({ owner: 'docker', repo: 'welcome-to-docker' }),
    resolveReadAccessToken: async () => token,
    getDefaultBranch: async () => 'main',
    detectRepoConfig: async () => ({
      buildType: 'dockerfile',
      dockerfilePath: 'Dockerfile',
      ports: [3000],
      env: [],
      suggestedName: 'welcome-to-docker',
      framework: null
    })
  };
  service.usersService = { findOrCreateByClerkId: async () => ({ id: 'user' }) };
  service.projectsService = {
    createProject: async () => {
      created.deployment = created.deployment ?? null;
      return { id: 'project', slug: 'web' };
    }
  };
  service.deployments = {
    createDeploymentFromGitHub: async (_id: string, data: any) => {
      created.deployment = data;
      return { id: 'deployment', name: 'web', autoDeployEnabled: false };
    }
  };
  service.ingress = {
    createAutoIngressForDeployment: async () => ({ url: 'https://web.example.test' })
  };
  return { service, created };
}

const req = { user: { sub: 'user', email: 'a@example.test' } };

test('import of a public repo with no token leaves auto-deploy to the service', async () => {
  const { service, created } = controller('');
  const result = await service.importFromGitHub(
    { organizationId: 'org', repoUrl: 'docker/welcome-to-docker', overrides: { name: 'web' } },
    req
  );
  assert.equal(created.deployment.autoDeployEnabled, undefined);
  assert.equal(created.deployment.dockerfilePath, 'Dockerfile');
  assert.equal(created.deployment.ports[0].containerPort, 3000);
  assert.equal(result.url, 'https://web.example.test');
  assert.equal(result.autoDeployEnabled, false);
});

test('import of a repo the caller cannot read creates nothing', async () => {
  const { service, created } = controller(null);
  await assert.rejects(
    service.importFromGitHub({ organizationId: 'org', repoUrl: 'acme/private' }, req),
    ForbiddenException
  );
  assert.deepEqual(created, {});
});

test('from-github with no build detects one, and an explicit build is left alone', async () => {
  const { service } = controller('');
  const detected = await service.withDetectedBuild(
    { githubRepo: 'docker/welcome-to-docker', port: 8080 },
    'user',
    {}
  );
  assert.equal(detected.buildType, 'dockerfile');
  assert.equal(detected.dockerfilePath, 'Dockerfile');
  assert.equal(detected.port, 8080);
  assert.equal(detected.branch, 'main');

  const explicit = {
    githubRepo: 'docker/welcome-to-docker',
    branch: 'dev',
    dockerfilePath: 'app/Dockerfile'
  };
  assert.equal(await service.withDetectedBuild(explicit, 'user', {}), explicit);
});

test('from-github on a git provider never asks GitHub', async () => {
  const { service } = controller('');
  service.githubService = null;
  const body = { gitConnectionId: 'conn', repoUrl: 'https://gitlab.example.test/a/b' };
  assert.equal(await service.withDetectedBuild(body, 'user', {}), body);
});

test('a Railpack port follows an explicit port, and the caller env wins', () => {
  const det: any = {
    buildType: 'railpack',
    dockerfilePath: null,
    ports: [3000],
    rootDirectory: 'web',
    framework: 'next',
    startCommand: 'node server.js',
    outputDirectory: null
  };
  const explicit = detectedBuildFor(det, { port: 8080 });
  assert.deepEqual(explicit.env, [{ key: 'PORT', value: '8080' }]);
  assert.equal(explicit.rootDirectory, 'web');

  const fallback = detectedBuildFor(det, {});
  assert.equal(fallback.port, 3000);
  assert.deepEqual(fallback.env, [{ key: 'PORT', value: '3000' }]);

  const kept = detectedBuildFor(det, { env: [{ key: 'PORT', value: '9000' }] });
  assert.deepEqual(kept.env, [{ key: 'PORT', value: '9000' }]);

  const declared = detectedBuildFor(det, { declaresPorts: true });
  assert.equal(declared.port, undefined);
  assert.deepEqual(declared.env, []);
});
