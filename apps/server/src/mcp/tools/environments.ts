import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod4';
import { OrchardClient, path } from '../client';
import { json } from './reply';

interface SharedVar {
  key: string;
  value: string | null;
  secret?: boolean;
}

export function registerEnvironmentTools(server: McpServer, client: OrchardClient) {
  server.registerTool(
    'list_environments',
    {
      description: `List a project's environments — production, staging, preview and whatever else it has.

Each environment is its own Kubernetes namespace with its own deployments, databases, ingresses and shared variables, so an environment id is what you pass to \`create_deployment\` / \`deploy_from_github\` to land an app somewhere other than production. Every project has at least one, marked \`isDefault\`.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID')
      }
    },
    async ({ projectId }) => {
      const environments = await client.get(path`/projects/${projectId}/environments`);
      return json(environments);
    }
  );

  server.registerTool(
    'create_environment',
    {
      description: `Create a new environment in a project, e.g. staging or preview.

Provisions a fresh namespace. Nothing is copied from production: the new environment starts with no deployments, no databases and no shared variables.`,
      inputSchema: {
        projectId: z.guid().describe('The project UUID'),
        name: z.string().describe('Environment name, e.g. Staging'),
        slug: z
          .string()
          .optional()
          .describe('URL/namespace slug. Derived from the name when omitted.')
      }
    },
    async ({ projectId, name, slug }) => {
      const environment = await client.post(path`/projects/${projectId}/environments`, {
        name,
        ...(slug && { slug })
      });
      return json(environment);
    }
  );

  server.registerTool(
    'rename_environment',
    {
      description:
        'Rename an environment. The slug and namespace are frozen, so nothing that resolves by slug moves.',
      inputSchema: {
        environmentId: z.guid().describe('The environment UUID (from list_environments)'),
        name: z.string().describe('The new name')
      }
    },
    async ({ environmentId, name }) => {
      const result = await client.patch(path`/environments/${environmentId}`, { name });
      return json(result);
    }
  );

  server.registerTool(
    'set_default_environment',
    {
      description:
        'Make an environment the project default — the one resources land in when a create call omits environmentId. Does not move anything that already exists.',
      inputSchema: {
        environmentId: z.guid().describe('The environment UUID (from list_environments)')
      }
    },
    async ({ environmentId }) => {
      const result = await client.post(path`/environments/${environmentId}/set-default`);
      return json(result);
    }
  );

  server.registerTool(
    'get_shared_env_vars',
    {
      description: `Read an environment's shared variables: a pool of values that every deployment in the environment can reference, so something like an API key lives in one place instead of being pasted onto each app.

**They are not injected automatically.** A deployment opts in by setting one of its own env vars to \`\${{shared.KEY}}\` (via \`add_env_vars\`); the reference is expanded when the pod spec and build args are built. Referencing a secret shared var makes the referencing var secret too, so it still routes through the Kubernetes Secret.

Secrets come back here with a null value — they are write-only.`,
      inputSchema: {
        environmentId: z.guid().describe('The environment UUID (from list_environments)')
      }
    },
    async ({ environmentId }) => {
      const vars = await client.get(path`/environments/${environmentId}/shared-vars`);
      return json(vars);
    }
  );

  server.registerTool(
    'add_shared_env_vars',
    {
      description: `**The default way to change shared variables.** Adds or overwrites the keys you pass and leaves the rest of the environment's shared set alone.

Deployments that reference a changed key via \`\${{shared.KEY}}\` are restarted; the rest are left running. Defining a var here does nothing on its own — point a deployment at it with \`add_env_vars\` and the value \`\${{shared.KEY}}\`.

Related: \`delete_shared_env_vars\` to remove keys, \`set_shared_env_vars\` only when you mean to replace the whole set.`,
      inputSchema: {
        environmentId: z.guid().describe('The environment UUID (from list_environments)'),
        vars: z
          .array(
            z.object({
              key: z.string().describe('Variable name'),
              value: z
                .string()
                .nullable()
                .describe('Value. Null keeps whatever is already stored under this key.'),
              secret: z
                .boolean()
                .optional()
                .describe('Store encrypted and write-only: reads never return the value')
            })
          )
          .describe('Variables to add or overwrite')
      }
    },
    async ({ environmentId, vars }) => {
      const current: SharedVar[] = await client.get(
        path`/environments/${environmentId}/shared-vars`
      );
      // Same merge shape as add_env_vars: a secret reads back valueless, so it
      // has to be carried through as null-with-flag or the replace would either
      // blank it or ask the server to republish it in the clear.
      const existing = (current || []).map((v) => ({
        key: v.key,
        value: v.value ?? null,
        secret: v.secret
      }));
      const incoming = new Set(vars.map((v) => v.key));
      const merged = [...existing.filter((v) => !incoming.has(v.key)), ...vars];

      const result = await client.put(path`/environments/${environmentId}/shared-vars`, {
        vars: merged
      });
      return json(result);
    }
  );

  server.registerTool(
    'set_shared_env_vars',
    {
      description: `Replace an environment's ENTIRE shared variable set with the list you pass. Anything you leave out is deleted, and any deployment referencing it via \`\${{shared.KEY}}\` resolves it to an empty string.

Use \`add_shared_env_vars\` to change a few, \`delete_shared_env_vars\` to remove a few. Secrets read back valueless, so pass \`value: null\` with \`secret: true\` to keep one through a replace.`,
      inputSchema: {
        environmentId: z.guid().describe('The environment UUID (from list_environments)'),
        vars: z
          .array(
            z.object({
              key: z.string().describe('Variable name'),
              value: z
                .string()
                .nullable()
                .describe('Value. Null keeps whatever is already stored under this key.'),
              secret: z
                .boolean()
                .optional()
                .describe('Store encrypted and write-only: reads never return the value')
            })
          )
          .describe('The complete shared set. Omitted keys are deleted.')
      }
    },
    async ({ environmentId, vars }) => {
      const result = await client.put(path`/environments/${environmentId}/shared-vars`, { vars });
      return json(result);
    }
  );

  server.registerTool(
    'delete_shared_env_vars',
    {
      description:
        'Remove specific shared variables from an environment by key name, leaving the rest alone. Any deployment whose env references a removed key via `${{shared.KEY}}` resolves it to an empty string and restarts, so check `get_deployment.envVars` for references before removing one.',
      inputSchema: {
        environmentId: z.guid().describe('The environment UUID (from list_environments)'),
        keys: z.array(z.string()).describe('Variable names to delete')
      }
    },
    async ({ environmentId, keys }) => {
      const current: SharedVar[] = await client.get(
        path`/environments/${environmentId}/shared-vars`
      );
      const existing = (current || []).map((v) => ({
        key: v.key,
        value: v.value ?? null,
        secret: v.secret
      }));
      const doomed = new Set(keys);
      const kept = existing.filter((v) => !doomed.has(v.key));

      const removed = keys.filter((k) => existing.some((v) => v.key === k));
      const notFound = keys.filter((k) => !existing.some((v) => v.key === k));

      const result = await client.put(path`/environments/${environmentId}/shared-vars`, {
        vars: kept
      });
      return json({
        removed,
        notFound: notFound.length > 0 ? notFound : undefined,
        vars: result
      });
    }
  );
}
