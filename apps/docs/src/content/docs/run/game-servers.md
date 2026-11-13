---
title: Run game servers next to your apps
description: Run a Minecraft, Valheim, Palworld, Satisfactory, or Enshrouded server on Orchard, on the same server as your websites and databases, with a public TCP or UDP port.
sidebar:
  order: 4
---

Orchard runs a game server the same way it runs a website. A game server is an app with a public TCP or UDP port and a volume for its world. It runs next to your other apps and databases, with the same logs, metrics, alerts, and quotas.

## Game templates

Each template creates a game server with its port and its volume already set.

| Template     | What it runs                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Minecraft    | A Paper, Purpur, Vanilla, Fabric, NeoForge, Forge, or Quilt server, or a CurseForge or Modrinth pack |
| Valheim      | A dedicated server with automatic updates and backups                                                |
| Palworld     | A dedicated server. It needs at least 8 GB of memory.                                                |
| Satisfactory | A dedicated server with autosave, which pauses when nobody plays                                     |
| Enshrouded   | A dedicated server                                                                                   |

To browse every template, go to [orchard.hackclub.com/templates](https://orchard.hackclub.com/templates).

## Prerequisites

- A public IP address for your organization, or an instance default. For more information, refer to [Publish a TCP or UDP port](/deploy/networking/#publish-a-tcp-or-udp-port).
- A layer 4 (L4) load balancer in the cluster.
- Enough free memory for the game. Each template shows its size before you deploy.

Public game ports do not work in Cloudflare Tunnel mode, because tunnels carry HTTP only.

## Deploy a game server

1. Open a project.
2. Select **New app**.
3. Search for the game, such as **Minecraft Server**.
4. Fill in the parameters, such as the server type, the version, and the memory.
5. Select the deploy button.
6. When the app is running, open it and go to **Network**. The public address is in **Ports**.
7. Give the public address to your players.

From the CLI, run `orchard template list` to find the template ID, then run the following command:

```sh
orchard template deploy <template-id> --param appName=minecraft
```

## Keep the world safe

- The world is on a volume, so it survives restarts and redeploys.
- Orchard does not back up app volumes. Copy the world somewhere else from a [shell](/run/logs/#open-a-shell) in the container, or use the game's own backups, such as the Valheim template's.
- An app with a volume stops before it updates, so players disconnect for a moment during an update. For more information, refer to [Choose an update strategy](/deploy/update-strategies/).

## Share the server with your apps

- **Size:** Set the CPU and memory of the game server so that it cannot use the memory your apps need. For more information, refer to [Scale an app](/deploy/scaling/).
- **Quotas:** Cap what each organization and member can use. For more information, refer to [Quotas](/teams/quotas/).
- **Placement:** On a cluster with more than one node, put the game server on its own node with a [node pool](/operate/nodes/).
- **Idle time:** Stop the app when nobody plays. Stopping an app scales it to zero and keeps its world. For more information, refer to [Stop and start an app](/deploy/scaling/#stop-and-start-an-app).
- **Crashes:** Get a message in Discord, Slack, or email when the server crashes. For more information, refer to [Set up notifications](/run/notifications/).
- **Console:** Read the server log and open a shell in the container from the app's page. For more information, refer to [Read logs and open a shell](/run/logs/).

Public TCP and UDP traffic skips the HTTP layer, so [app protection](/deploy/protection/) does not apply. Use the game's own allowlist or password to control who joins.

## Related resources

- [Deploy and write templates](/run/templates/)
- [Configure app networking](/deploy/networking/)
- [Attach storage to an app](/deploy/storage/)
