---
title: score.yaml
description: Describe an app's ports, variables and databases in the repository and let Orchard provision them.
sidebar:
  order: 10
---

A repository can commit a [Score](https://score.dev) file, `score.yaml` or
`score.yml`, and Orchard reads it when the app is created and again on every push
that auto-deploys. The file describes the workload; `orchard.json` keeps describing
the build.

```yaml
apiVersion: score.dev/v1b1
metadata:
  name: web
  annotations:
    orchard.my/domain: midnight.example.com
    orchard.my/replicas: "2"
containers:
  web:
    image: .
    variables:
      DATABASE_URL: ${resources.db.connection_string}
      LOG_LEVEL: info
service:
  ports:
    www:
      port: 8080
      targetPort: 3000
resources:
  db:
    type: postgres
```

## What each part becomes

| Score | Orchard |
| --- | --- |
| `containers.<first>.variables` | The app's variables. Keys not in the file are left alone |
| `service.ports` | The app's service ports |
| `resources.<name>` with `type: postgres` | A managed database on the project named `<name>`, created if missing and connected to the app |
| `${resources.<name>.<field>}` | A live reference to that database, resolved when the pod starts |
| `orchard.my/domain` | A custom domain routed to the app |
| `orchard.my/replicas` | The replica count |

Only the first container is deployed. `image: .` means the image Orchard builds;
another image is accepted but the build still comes from the repository.

## Live references, not copies

`${resources.db.connection_string}` never becomes a pasted connection string. It is
written as `${{resource.db.connection_string}}`, the same reference you get from
connecting a database under Variables, and it follows the database through a
password rotation or a restore. The fields are `connection_string`, `host`, `port`,
`name` (or `database`), `username` (or `user`) and `password`.

A reference to something the file does not provision is left as it is and called
out, and the app refuses to start with it rather than shipping an empty value.

## What is not provisioned

`type: redis` is recognised but managed Valkey is not available yet, so it is
reported and skipped. Any other resource type is ignored with a note.
`orchard.my/health-path` is read but health checks are not set from Score yet.

## Where to see it

The new app form shows a summary of the file when it finds one: the databases it
will provision, the ports and the domain. After that, each apply is a line in the
audit log with what changed.
