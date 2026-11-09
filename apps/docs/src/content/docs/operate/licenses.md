---
title: Licenses
description: Find Orchard's license and the third-party notices for each part of Orchard.
---

Orchard is licensed under the [GNU Affero General Public License v3.0](https://github.com/hackclub/orchard/blob/main/LICENSE) (AGPL). The exception is the graft SDK, `packages/graft-sdk`, which is licensed under the MIT License.

## Modified versions

If you run a modified version of Orchard that other people use over a network, you must offer those people the source code of your version. A link in your instance's interface or documentation is one way to do this. If you run a modified version, point the **Source** link in the account menu at your source with `PUBLIC_SOURCE_URL` on the frontend, or `frontend.sourceUrl` in the Helm chart.

The AGPL adds no further requirement if you run an unmodified version.

## Third-party notices

Each part of Orchard includes the copyright notices and license texts of the open-source software built into it.

| Part                                     | Location                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| Dashboard                                | `/third-party-notices.txt` on your instance, and **Open source licenses** in the account menu |
| API server and MCP images                | `/app/THIRD_PARTY_NOTICES.txt`                                                                |
| R2 proxy image                           | `/THIRD_PARTY_NOTICES.txt`                                                                    |
| [CLI](/cli/)                             | `orchard licenses`, and `THIRD_PARTY_NOTICES.txt` in each release archive                     |
| [Terraform provider](/run/terraform/)    | `THIRD_PARTY_NOTICES.txt` in each release archive                                             |
| [Host commands](/operate/host-commands/) | `orchardctl licenses`                                                                         |
| This documentation                       | [third-party-notices.txt](/third-party-notices.txt)                                           |

For all notices in one place, refer to [orchard.my/credits](https://orchard.my/credits).

## Related resources

- [What is Orchard](/start/what-is-orchard/)
- [Use the CLI](/cli/)
- [Host commands](/operate/host-commands/)
