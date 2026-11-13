import { links } from '$lib/links';
import { SITE } from '$lib/site';

export const prerender = true;

const body = `# Orchard

> Orchard is an open-source, self-hosted platform as a service (PaaS) from Hack Club that runs on servers you own. One command installs k3s and Orchard on a Linux server. Then you deploy apps from GitHub, GitLab, Gitea or a local folder, with Postgres, HTTPS, logs, rollbacks and an MCP server for AI agents.

Orchard is free and licensed under the AGPL. It is a Hack Club project.

## Start here

- [Install guide](${links.install}): one command on a Linux server, amd64 or arm64.
- [Install guide for agents](https://docs.orchard.hackclub.com/start/install.md): give this to a coding agent to install Orchard for you.
- [Docs](${links.docs}) and [docs for LLMs](https://docs.orchard.hackclub.com/llms.txt)
- [Source code](${links.github})

## More

- [Templates](${SITE}/templates): one-click apps like Minecraft, n8n and Open WebUI.
- [Self-hosted PaaS](${SITE}/self-hosted-paas): what you get when you run Orchard on your own server.
- [Compare](${SITE}/compare): how Orchard compares with other self-hosted platforms, feature by feature.
- [Extensions](${SITE}/extensions): grafts that add pages, APIs and MCP tools to Orchard.
- [MCP server](${links.mcp}) and [CLI](${links.cli})
`;

export function GET() {
	return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
