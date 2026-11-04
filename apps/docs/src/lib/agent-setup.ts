import type { MarkName, IconName } from './icons';
import { MCP_URL } from './nav';

export interface SetupStep {
  text: string;
  code?: string;
  title?: string;
}

export interface SetupClient {
  id: string;
  name: string;
  vendor: string;
  mark?: MarkName;
  icon?: IconName;
  steps: SetupStep[];
}

export interface ExamplePrompt {
  title: string;
  text: string;
  prompt: string;
  tools: string[];
}

export const AGENT_SETUP = {
  title: 'Agent setup',
  description: 'Connect your coding agent to Orchard, then deploy and debug from your editor or terminal.',
  browse: 'Browse clients',
  pickHeading: 'Pick your client',
  pickText: 'Select a client to get its setup instructions.',
  urlHeading: 'Find your MCP URL',
  urlText:
    'Replace your-orchard-domain in the examples with your domain. Settings → MCP shows the exact URL for your instance.',
  limitHeading: 'Limit what an agent can do',
  limitText: 'Add parameters to the server URL. They can only lower what a connection gets.',
  promptsHeading: 'Example prompts',
  promptsText: 'Paste these into a connected agent. Each prompt names the tools it uses.'
};

const url = `${MCP_URL}/`;

export const clients: SetupClient[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    vendor: 'Anthropic',
    mark: 'claude',
    steps: [
      {
        text: 'Add the server:',
        code: `claude mcp add --transport http orchard ${url}`
      },
      { text: 'Run `/mcp` in Claude Code and sign in with your Orchard account.' },
      {
        text: 'To share the server with a project, add `.mcp.json` instead:',
        title: '.mcp.json',
        code: `{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${url}"
    }
  }
}`
      }
    ]
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    mark: 'codex',
    steps: [
      {
        text: 'Add the server:',
        code: `codex mcp add orchard --url ${url}`
      },
      {
        text: 'Sign in with your Orchard account:',
        code: 'codex mcp login orchard'
      }
    ]
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Cursor',
    mark: 'cursor',
    steps: [
      {
        text: 'Add `.cursor/mcp.json` to a project, or `~/.cursor/mcp.json` for every project:',
        title: '.cursor/mcp.json',
        code: `{
  "mcpServers": {
    "orchard": {
      "url": "${url}"
    }
  }
}`
      },
      { text: 'Cursor asks you to sign in on first use.' }
    ]
  },
  {
    id: 'vscode',
    name: 'VS Code',
    vendor: 'Microsoft',
    mark: 'vscode',
    steps: [
      {
        text: 'Run **MCP: Add Server** from the Command Palette, or add `.vscode/mcp.json` to your project:',
        title: '.vscode/mcp.json',
        code: `{
  "servers": {
    "orchard": {
      "type": "http",
      "url": "${url}"
    }
  }
}`
      },
      { text: 'VS Code asks you to sign in.' }
    ]
  },
  {
    id: 'claude',
    name: 'Claude.ai',
    vendor: 'Anthropic',
    mark: 'claude',
    steps: [
      { text: 'In Claude, open **Settings** → **Connectors** and select **Add custom connector**.' },
      { text: 'Paste the server URL:', code: url },
      { text: 'Sign in with your Orchard account.' }
    ]
  },
  {
    id: 'others',
    name: 'Other clients',
    vendor: 'Any MCP client',
    icon: 'plug',
    steps: [
      { text: 'Amp:', code: `amp mcp add orchard '${url}'` },
      {
        text: 'For a client without OAuth, create an API token and send it as a bearer token:',
        title: 'mcp.json',
        code: `{
  "mcpServers": {
    "orchard": {
      "type": "http",
      "url": "${url}",
      "headers": {
        "Authorization": "Bearer orch_your_token_here"
      }
    }
  }
}`
      },
      {
        text: 'Tokens created in Settings → API Tokens are read-only. To let an agent make changes, create a token with the CLI:',
        code: 'orchard auth token create --name "ci-agent" --scope deploy'
      }
    ]
  }
];

export const urlOptions = [
  { label: 'Read-only tools', code: `${MCP_URL}/?scope=read` },
  { label: 'No `exec_in_pod`', code: `${MCP_URL}/?scope=deploy` },
  { label: 'Selected toolsets', code: `${MCP_URL}/?toolsets=databases,domains` },
  { label: 'The whole API in three tools', code: `${MCP_URL}/compact` }
];

export const examplePrompts: ExamplePrompt[] = [
  {
    title: 'Deploy a repository',
    text: 'Requires a linked GitHub account.',
    prompt:
      'Deploy https://github.com/owner/repo to Orchard. Check access with list_github_deploy_targets, deploy with deploy_from_github_url, then wait on get_deployment_rollout and give me the URL.',
    tools: ['list_github_deploy_targets', 'deploy_from_github_url', 'get_deployment_rollout']
  },
  {
    title: 'Find out why an app is failing',
    text: 'Read-only. Works with `?scope=read`.',
    prompt:
      'The api app is failing. Call diagnose_deployment, then read get_deployment_logs and get_killed_container_logs. Tell me the cause. Do not change anything.',
    tools: ['diagnose_deployment', 'get_deployment_logs', 'get_killed_container_logs']
  },
  {
    title: 'Create a database',
    text: 'Stores the connection string as a secret variable.',
    prompt:
      'Create a PostgreSQL database named app-db with create_database. Get its connection string with get_database_connection, then add it to the api app as a secret DATABASE_URL with add_env_vars.',
    tools: ['create_database', 'get_database_connection', 'add_env_vars']
  },
  {
    title: 'Roll back a bad deploy',
    text: 'Asks before it changes anything.',
    prompt:
      'The latest release of the api app is failing. List recent releases with list_releases. Ask me before you run rollback_to_previous, then confirm with get_deployment_rollout.',
    tools: ['list_releases', 'rollback_to_previous', 'get_deployment_rollout']
  },
  {
    title: 'Check app resources',
    text: 'Read-only. Works with `?scope=read`.',
    prompt:
      'Check whether the api app has the right CPU and memory. Use get_resource_recommendation and get_deployment_metrics. Do not change anything.',
    tools: ['get_resource_recommendation', 'get_deployment_metrics']
  },
  {
    title: 'Check a domain',
    text: 'Run this before you create an ingress.',
    prompt: 'Run validate_dns for app.example.com and tell me which records to create.',
    tools: ['validate_dns']
  }
];
