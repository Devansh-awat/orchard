---
title: Docs for agents
description: Read Orchard documentation as Markdown with .md URLs and llms.txt, and find the entry points that agents use to call the Orchard API.
---

Every page of this documentation is also available as plain Markdown, so an agent can read it without parsing HTML or running a browser. This page lists those Markdown sources, and the separate entry points an agent uses to operate an Orchard instance through MCP or the API.

## Get a page as Markdown

Add `.md` to a documentation URL:

```txt
https://docs.orchard.hackclub.com/start/install/      the page
https://docs.orchard.hackclub.com/start/install.md    its Markdown source
```

The home page is at `/index.md`.

Each page has these actions under its title:

| Action               | Result                                       |
| -------------------- | -------------------------------------------- |
| **Copy as Markdown** | Copies the page as Markdown.                 |
| **View as Markdown** | Opens the Markdown source.                   |
| **Agent setup**      | Opens the [agent setup](/agent-setup/) page. |

The menu next to them has **Open in Claude**, **Open in ChatGPT**, and **Connect to MCP**.

## Use llms.txt

Two files follow the [llms.txt](https://llmstxt.org) convention.

| File                                                                | Contents                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`/llms.txt`](https://docs.orchard.hackclub.com/llms.txt)           | An index of every page, grouped by section, with Markdown links. |
| [`/llms-full.txt`](https://docs.orchard.hackclub.com/llms-full.txt) | The entire documentation set as one document.                    |

Use `llms.txt` to decide what to read. Use `llms-full.txt` to load everything in one request.

## Operate an instance

This documentation has no MCP server. The Orchard MCP server runs at `mcp.<your domain>` and operates your instance instead of serving these pages. To set it up, refer to [Connect an MCP client](/mcp/).

An agent can also use the following entry points, which [code mode for agents](/agents-code-mode/) describes in detail.

| Entry point                         | Purpose                                                  |
| ----------------------------------- | -------------------------------------------------------- |
| `GET /apiv1/agent-spec.json`        | A trimmed spec of the operations that an agent can call. |
| `GET /apiv1/openapi.json`           | The complete OpenAPI document.                           |
| `orchard api search` and `describe` | The same spec from a shell, with calls by `operationId`. |
| `https://mcp.<domain>/compact`      | The whole API through three MCP tools.                   |

## Check whether a deploy worked

Send the following request:

```txt
GET /apiv1/deployments/:id/rollout?wait=1
```

The response has the phase and, when the deploy is live, the URL. When the deploy fails, it has the build error or the crashing pod with a log tail.

To [roll back](/deploy/rollbacks/) to the previous image, send `POST /apiv1/deployments/:id/rollback` with no history ID.

## Retry requests safely

To retry a request without doing the work twice, send an `Idempotency-Key` header. Orchard supports this header on requests that create a project, app, or database, rebuild, restart, or roll back an app, run a job, restart a database, and upgrade, fork, checkpoint, or restore a database.

A retry with the same key and body replays the first response for 24 hours. The same key with a different body returns a `422` status. A key that is still in progress returns a `409` status.

## Related resources

- [Use the CLI](/cli/) - Install the `orchard` CLI and script it with JSON output and stable exit codes.
- [MCP tools](/reference/mcp-tools/) - Every tool that the Orchard MCP server exposes.
