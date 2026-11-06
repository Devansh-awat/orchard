import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { ProjectAccessService } from '../src/projects/project-access.service';

function service() {
  const svc = Object.create(ProjectAccessService.prototype) as ProjectAccessService;
  (svc as any).prisma = {
    ingress: { findFirst: async () => null },
    organization: { findUnique: async () => null },
    statusPage: { findUnique: async () => null }
  };
  (svc as any).instanceSettings = { isCustomDomainVerificationRequired: async () => false };
  return svc;
}

const saved = process.env.MCP_BASE_URL;
const savedFrontend = process.env.FRONTEND_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_BASE_URL;
  else process.env.MCP_BASE_URL = saved;
  if (savedFrontend === undefined) delete process.env.FRONTEND_URL;
  else process.env.FRONTEND_URL = savedFrontend;
});

test('no app can take the dashboard hostname, even under the apps wildcard', async () => {
  process.env.FRONTEND_URL = 'https://orchard.apps.example.com';
  await assert.rejects(
    service().assertHostnameAvailable('orchard.apps.example.com', 'p1'),
    ConflictException
  );
  await service().assertHostnameAvailable('shop.apps.example.com', 'p1');
});

test('no app can take the MCP hostname', async () => {
  process.env.MCP_BASE_URL = 'https://mcp.apps.example.com';
  await assert.rejects(
    service().assertHostnameAvailable('MCP.apps.example.com', 'p1'),
    ConflictException
  );
  await service().assertHostnameAvailable('shop.apps.example.com', 'p1');
});

test('with no MCP hostname, mcp is an ordinary app name', async () => {
  delete process.env.MCP_BASE_URL;
  await service().assertHostnameAvailable('mcp.apps.example.com', 'p1');
});
