---
title: Templates
description: One-click stacks that create several resources together.
sidebar:
  order: 4
---

A template describes a set of resources and the parameters that fill them in.
Deploying one creates everything at once: an app, a database, an ingress, wired
together.

## Using one

**New** shows the templates available on the instance. Pick one, fill in the
parameters (a name, a domain, an image, resource sizes) and deploy. The result is
a **template instance** that groups what it made, so you can see the pieces and
delete them together.

Each created resource is a normal app or database afterwards: scale it, change
its variables, roll it back.

## Writing one

Templates are YAML. They declare the resources to create and the parameters to
prompt for, including defaults and which are required.

:::caution
Test a template end to end before publishing it. A template that references
software with a database it cannot actually use will deploy cleanly and then
crash-loop, which is a much worse experience than a template that does not exist.
Make sure the image supports the database you are attaching to it.
:::

## Instances

A template instance keeps track of the resources it created and their status.
Deleting the instance offers to delete everything it made.
