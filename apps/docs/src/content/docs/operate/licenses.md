---
title: Licenses
description: Orchard's license, and where each part of it keeps the notices for the open-source software inside.
---

Orchard is free software under the
[GNU Affero General Public License v3.0](https://github.com/hackclub/orchard/blob/main/LICENSE).
Run it, study it, change it and share it.

## If you change Orchard

The AGPL adds one rule for software used over a network. If you run a modified
Orchard that other people use, offer those people the source code of your
version, for example with a link in your instance's UI or docs. Running an
unmodified Orchard for your team asks nothing extra of you.

## Third-party notices

Every part of Orchard carries the copyright notices and license texts of the
open-source software built into it:

| Part                      | Where its notices live                                                                        |
| ------------------------- | --------------------------------------------------------------------------------------------- |
| Web app                   | `/third-party-notices.txt` on your instance, and **Open source licenses** in the account menu |
| API server and MCP images | `/app/THIRD_PARTY_NOTICES.txt`                                                                |
| R2 proxy image            | `/THIRD_PARTY_NOTICES.txt`                                                                    |
| CLI                       | `orchard licenses`, and `THIRD_PARTY_NOTICES.txt` in every release archive                    |
| Terraform provider        | `THIRD_PARTY_NOTICES.txt` in every release archive                                            |
| Host commands             | `orchardctl licenses`                                                                         |
| These docs                | [third-party-notices.txt](/third-party-notices.txt)                                           |

[orchard.my/credits](https://orchard.my/credits) lists all of it in one place,
along with the people who build Orchard.
