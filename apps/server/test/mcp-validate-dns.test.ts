import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerQueryTools } from '../src/mcp/tools/query';

function registerWithStubs() {
  const tools = new Map<string, { config: any; handler: any }>();
  const server = {
    registerTool: (name: string, config: any, handler: any) => {
      tools.set(name, { config, handler });
    },
  };
  const posts: { path: string; body: any }[] = [];
  const client = {
    get: async () => ({}),
    post: async (path: string, body: any) => {
      posts.push({ path, body });
      return { valid: true };
    },
  };
  registerQueryTools(server as any, client as any);
  return { tools, posts };
}

test('validate_dns requires projectId in its input schema', () => {
  const { tools } = registerWithStubs();
  const tool = tools.get('validate_dns');
  assert.ok(tool, 'validate_dns tool is registered');
  assert.ok(tool.config.inputSchema.projectId, 'schema has projectId');
  assert.equal(tool.config.inputSchema.projectId.isOptional(), false);
  assert.match(tool.config.inputSchema.projectId.description, /project UUID/i);
});

test('validate_dns posts projectId alongside domain', async () => {
  const { tools, posts } = registerWithStubs();
  const tool = tools.get('validate_dns');
  await tool.handler({ projectId: 'proj-123', domain: 'myapp.example.com' });
  assert.deepEqual(posts, [
    {
      path: '/projects/ingresses/validate-dns',
      body: { projectId: 'proj-123', domain: 'myapp.example.com' },
    },
  ]);
});
