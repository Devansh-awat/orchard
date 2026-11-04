import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { ProjectAccessService } from '../src/projects/project-access.service';

function service() {
  const svc = Object.create(ProjectAccessService.prototype) as ProjectAccessService;
  (svc as any).prisma = { ingress: { findFirst: async () => null } };
  return svc;
}

const saved = process.env.MCP_BASE_URL;
afterEach(() => {
  if (saved === undefined) delete process.env.MCP_BASE_URL;
  else process.env.MCP_BASE_URL = saved;
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
