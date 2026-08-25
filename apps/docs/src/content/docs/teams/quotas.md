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
