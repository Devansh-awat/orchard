# Greenhouse

Run coding agents on cloud machines that an Orchard instance manages. Each session works on its own branch in its own git worktree, so several sessions can share a machine. People review changes in a browser workspace or in a desktop editor over SSH, open pull requests, and preview a session's app.

A machine runs on one of two runners:

- Kubernetes: a pod on the cluster. This runner needs the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller and its CRDs, which the Orchard chart does not install.
- Vercel: a Vercel Sandbox on the operator's Vercel account.

The graft also adds MCP tools, and starts sessions from GitHub, Linear, and Slack.

The graft adopts the `sandboxes`, `sandbox_*`, and related tables that older Orchard releases keep in core, so existing machines keep their data.

For the user guide, refer to the [Greenhouse docs](https://docs.orchard.hackclub.com/greenhouse/). To install and configure it, refer to [Run Greenhouse](https://docs.orchard.hackclub.com/operate/greenhouse/).

To pack the graft, run:

```
pnpm --filter @grafts/greenhouse pack
```
