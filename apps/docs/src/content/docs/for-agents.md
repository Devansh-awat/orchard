---
title: Docs for agents
description: Markdown sources, llms.txt, and an MCP server for reading these docs.
---

These docs are built to be read by machines as well as people. Nothing here
requires scraping rendered HTML.

## The page menu

Every page has a **Copy page** button under its title, with a menu next to it:

| Action                     | Does                                                     |
| -------------------------- | -------------------------------------------------------- |
| **Open in ChatGPT**        | Opens ChatGPT primed to read this page                   |
| **Open in Claude**         | Opens Claude primed to read this page                    |
| **Copy page**              | Copies the markdown source for pasting into an assistant |
| **View as Markdown**       | Opens the raw source                                     |
| **Connect with MCP**       | Copies the MCP config for any compatible client          |
| **Connect to VS Code**     | One-click install through VS Code's MCP URL handler      |
| **Connect to Claude Code** | Copies `claude mcp add ...`                              |
| **Connect to Codex**       | Copies `codex mcp add ...`                               |
| **Export as PDF**          | Prints the page, so your browser can save it as a PDF    |

The two "open in" actions hand the assistant this page's `.md` URL rather than
pasting its full text, so the conversation starts with a link it can re-read
rather than a wall of pasted markdown.

## Markdown for any page

Append `.md` to any documentation URL:

```
https://docs.orchard.my/start/install/     → the page
https://docs.orchard.my/start/install.md   → its markdown source
```

The home page is at `/index.md`.

## llms.txt

Two files follow the [llms.txt](https://llmstxt.org) convention:

| File                                                      | Contains                                                               |
| --------------------------------------------------------- | ---------------------------------------------------------------------- |
| [`/llms.txt`](https://docs.orchard.my/llms.txt)           | A compact index of every page, grouped by section, linking to markdown |
| [`/llms-full.txt`](https://docs.orchard.my/llms-full.txt) | The entire documentation set as one markdown document                  |

Use `llms.txt` to decide what to read. Use `llms-full.txt` when you want
everything in one request and have the context budget for it.

## What about MCP?

There is no MCP server for these docs, deliberately.

An MCP server for a documentation site is only useful if it is **remote**: a URL
any client can point at. A local one would have to run from a checkout of this
repository, which means the only people who could use it are the people who
already have the markdown on disk.

`llms.txt` and the `.md` URLs cover the same ground with nothing to install, and
they work against the published site from anywhere.

## Orchard's own MCP is a different thing

Orchard itself **does** have an MCP server, and it is remote. It exposes the
platform rather than the docs: deploying, databases, logs, scaling. It answers on
its own hostname, `mcp.<your orchard domain>`, and is documented under
[MCP for agents](/mcp/).

So: point your agent at Orchard's MCP to _operate_ the platform, and at
`llms.txt` to _read_ about it.

## Driving the API directly

An agent that needs more than the MCP tools cover has more entry points,
all described in [Code mode for agents](/agents-code-mode/):

| Entry point                       | For                                                              |
| --------------------------------- | ---------------------------------------------------------------- |
| `GET /apiv1/agent-spec.json`      | A trimmed, searchable spec of every operation an agent can call  |
| `GET /apiv1/openapi.json`         | The complete OpenAPI document                                    |
| `orchard api search` / `describe` | The same spec from a shell, cached, with calls by `operationId`  |
| `https://mcp.<domain>/compact`    | The whole API through three MCP tools, for clients with no shell |

To find out whether a deploy worked, ask
`GET /apiv1/deployments/:id/rollout?wait=1`. It answers with the phase, the
URL when it is live, and the build error or crashing pod with a log tail when
it is not.

Agents retry. Send an `Idempotency-Key` header on create, deploy, rebuild,
restart, rollback, database create and job run calls, and a retry with the
same key and body replays the first response for 24 hours instead of doing the
work twice. `POST /apiv1/deployments/:id/rollback` with no history id rolls
back to the previous image.
