---
title: Deploy from GitLab, Gitea and others
description: Link a git provider with your own account and deploy from it, with auto-deploy on push.
sidebar:
  order: 2
---

GitHub goes through the [GitHub App](/deploy/github/). Everything else goes through a
git provider you link to your own account: GitLab, Gitea, Forgejo and Codeberg,
Bitbucket Cloud, a self-hosted GitHub, or any git host that serves https.

## Linking a provider

Under your settings, Connections, there are two ways in.

**One click.** When the instance admin has registered an OAuth app for GitLab or
Bitbucket, a Continue with GitLab or Continue with Bitbucket button signs you in and
links your account. Tokens are refreshed for you. Admins register the apps under
Instance, Configuration; a self-hosted GitLab works by setting its base URL there.

**With a token.** Add with a token takes a provider, a name, the host and an access
token. Use it for a self-hosted Gitea, a GitLab the admin has not registered, or a
plain git host. The token is stored encrypted and checked once before it is saved.

A provider is yours. Orchard lists only the repositories your token can see, and only
you can start apps from it.

| Provider                 | Token                                 | Scopes                        |
| ------------------------ | ------------------------------------- | ----------------------------- |
| GitLab                   | personal or project access token      | `read_api`, `read_repository` |
| Gitea, Forgejo, Codeberg | access token                          | repository read               |
| Bitbucket Cloud          | app password, with your username      | repository read               |
| GitHub with a token      | fine-grained token                    | contents read                 |
| Any git host             | the password used to clone over https | none                          |

## Creating an app

On the new app form pick Git, then the provider, then a repository from the list or
by URL, then a branch. Detection runs the same way it does for GitHub: Dockerfiles,
frameworks, ports, and a [`score.yaml`](/deploy/score/) if there is one.

From the CLI:

```sh
orchard git add --provider gitlab --name work --token glpat-...
orchard deploy create --git work --repo https://gitlab.com/group/app#main
```

## Auto-deploy

Turning auto-deploy on for an app from a provider registers a push webhook on the
repository through the provider's API, signed with a secret that belongs to that
provider alone. A push then builds the app exactly as a GitHub push would, including
watch paths.

The app's settings show whether the webhook is in place. A plain git host has no API
to register with, so the card shows the URL and the secret to paste into the
repository's webhook settings yourself. `orchard git webhook <name>` prints the same
pair.

## Who can do what

Listing repositories, branches and detection run only for the person who linked the
provider, and only they can create an app from it or change which repository an app
builds from. That repository has to stay on the same host. Once an app exists, project
membership governs it the way it does for any app: members can rebuild it, read its
logs and turn auto-deploy on or off. Builds clone with the linking person's token,
which is also how the GitHub App path behaves.

## When someone leaves

Apps keep the provider they were created from. If the person who linked it leaves or
removes it, builds from it fail with a clear message and another member re-creates
the app from their own provider. A provider that still has apps cannot be removed.
