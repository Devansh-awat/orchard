---
title: Docs for agents
description: Read Orchard documentation as Markdown with .md URLs and llms.txt, and find the entry points that agents use to call the Orchard API.
---

To give an agent access to this documentation, use the Markdown sources. To let an agent operate an Orchard instance, use MCP or the API.

## Get a page as Markdown

Add `.md` to a documentation URL:

```txt
https://docs.orchard.my/start/install/      the page
https://docs.orchard.my/start/install.md    its Markdown source
```

The home page is at `/index.md`.

Each page also has a **Copy page** button under its title, with a menu next to it:

| Action               | Result                                       |
| -------------------- | -------------------------------------------- |
| **Open in ChatGPT**  | Opens ChatGPT and asks about this page.      |
| **Open in Claude**   | Opens Claude and asks about this page.       |
| **Copy page**        | Copies the page as Markdown.                 |
| **View as Markdown** | Opens the Markdown source.                   |
| **Export as PDF**    | Prints the page, so you can save it as a PDF. |

## Use llms.txt

Two files follow the [llms.txt](https://llmstxt.org) convention.

| File                                                      | Contents                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------- |
| [`/llms.txt`](https://docs.orchard.my/llms.txt)           | An index of every page, grouped by section, with Markdown links. |
| [`/llms-full.txt`](https://docs.orchard.my/llms-full.txt) | The entire documentation set as one document.                  |

Use `llms.txt` to decide what to read. Use `llms-full.txt` to load everything in one request.

## Operate an instance

This documentation has no MCP server. The Orchard MCP server operates your instance and does not serve these pages. It runs at `mcp.<your domain>`. For setup, refer to [Connect an MCP client](/mcp/).

An agent can also use the following entry points. For more information, refer to [Code mode for agents](/agents-code-mode/).

| Entry point                       | Purpose                                                  |
| --------------------------------- | -------------------------------------------------------- |
| `GET /apiv1/agent-spec.json`      | A trimmed spec of the operations that an agent can call. |
| `GET /apiv1/openapi.json`         | The complete OpenAPI document.                           |
| `orchard api search` and `describe` | The same spec from a shell, with calls by `operationId`. |
| `https://mcp.<domain>/compact`    | The whole API through three MCP tools.                   |

## Check whether a deploy worked

Send the following request:

```txt
GET /apiv1/deployments/:id/rollout?wait=1
```

The response has the phase and, when the deploy is live, the URL. When the deploy fails, it has the build error or the crashing pod with a log tail.

To roll back to the previous image, send `POST /apiv1/deployments/:id/rollback` with no history ID.

## Retry requests safely

To retry a request without doing the work twice, send an `Idempotency-Key` header. Orchard supports this header on create, deploy, rebuild, restart, rollback, database create, and job run requests.

A retry with the same key and body replays the first response for 24 hours. The same key with a different body returns a `422` status. A key that is still in progress returns a `409` status.

## Related resources

- [Connect an MCP client](/mcp/)
- [Code mode for agents](/agents-code-mode/)
- [Use the CLI](/cli/)
