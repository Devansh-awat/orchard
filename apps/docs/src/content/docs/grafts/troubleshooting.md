---
title: Troubleshooting grafts
description: Why a graft did not load, and how to get Orchard running again.
sidebar:
  order: 4
---

Admin → Grafts shows every graft's status. A graft that failed says which phase
it failed in. `sudo orchardctl graft list` shows the same, plus the latest
messages about grafts from the server logs.

| Phase          | Means                                                                                                    | Fix                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `sync`         | The download failed, the digest did not match, or the signature did not verify against your trust policy | Check `digest` in your values and your [trust policy](/grafts/install/#trust) |
| `manifest`     | `graft.json` is invalid                                                                                  | Ask the publisher for a fixed version                                         |
| `integrity`    | A file does not match the signed file list                                                               | Reinstall; never edit files inside an installed graft                         |
| `compat`       | The graft needs a different Orchard version, graft SDK or door                                           | Upgrade Orchard, or install a version of the graft that matches               |
| `dependencies` | A graft it needs is missing, failed, or the wrong version                                                | Install or fix the other graft first                                          |
| `migrations`   | Its database changes failed. They were rolled back                                                       | Read the error; it is usually a bug in the graft                              |
| `load`         | Its server code threw while loading                                                                      | A bug in the graft                                                            |
| `routes`       | Its routes do not match what it was packed with, or it opens a route to anyone without declaring it      | A bug in the graft, or a modified file                                        |
| `boot`         | Orchard could not start with it. Orchard started without it                                              | Read the reason; often a missing capability in `graft.json`                   |

A path shown as **taken** on Admin → Grafts is a name the graft asked for that
core Orchard or another graft already uses. The graft still works under its own
`/<graft-id>/` paths.

## Orchard will not start

With `graftSettings.strict` off (the default), a broken graft is skipped and
Orchard starts without it. If a graft misbehaves while running instead, turn
every graft off at once:

```sh
sudo orchardctl config set graftSettings.safeMode true --apply
```

Then remove the culprit and set `safeMode` back to `false`.
