---
title: Quotas and usage
description: Organization caps, per-member allowances, and where the capacity went.
sidebar:
  order: 5
---

Quotas exist because a cluster is finite and one person requesting 32 cores for a
side project affects everyone else on it.

## Three levels

```
Organization cap
└── Member allowance
    └── App request
```

The **effective limit** for a new app is the smaller of what is left in your
allowance and what is left in the organization's cap. The resource picker shows
this as a budget bar while you size an app, so you find out before you deploy
rather than after it is rejected.

A member with no explicit allowance falls back to the organization default, and
then to unlimited if there is no default.

## Enforcement

Quotas are enforced when an app is created, scaled, or has its resources changed.
They are enforced against **requests**, which on Orchard equal limits, so the
number you pick is the number that counts.

## Who pays for a project

Every app and database sits inside a project, and a project has an **owner**. The
owner's allowance is what the whole project is charged against, whoever actually
deployed the thing. The owner is the person who created the project until someone
transfers it.

### Transferring ownership

Because ownership decides whose allowance foots the bill, it moves as a handshake
rather than an assignment. The current owner, or an organization owner or admin,
opens a request from the project's danger menu; the request sits there until the
recipient accepts or declines it, and it expires after seven days.

The new owner has to already be a member of the project, and accepting makes them
a project admin, since the person carrying the bill needs to be able to administer
what is running it up. The old owner keeps whatever role they had.

A transfer is rejected if the project's total request would not fit inside the new
owner's allowance. Raise their allowance, or shrink the project, and try again.

From the CLI:

```bash
orchard project transfer request someone@example.com
orchard project transfer list        # requests waiting on you
orchard project transfer accept <requestId>
```

## Usage

The **Usage** page shows what is actually consumed:

- Organization capacity, with CPU, memory, pods and services against their caps
- CPU by project
- A per-project table
- Per-person usage, so "who has the capacity" has an answer

Unlimited caps show as unlimited rather than as a full bar.

## Right-sizing

Sizing against real usage is the whole game. Metrics over a range are the input;
an instantaneous sample will mislead you on anything spiky. Size for the peak you
care about, not the average and not the number that happened to be on screen.
