---
title: score.yaml
description: Describe an Orchard app's ports, variables, and databases in a Score file in the repository. Orchard reads the file on creation and on each auto-deploy push.
sidebar:
  order: 10
---

A [Score](https://score.dev) file lets you keep an app's ports, variables, and databases in the repository next to the code, instead of setting them by hand in the dashboard. Score is an open specification, so the same file can describe the workload to other platforms. Name the file `score.yaml` or `score.yml`. Orchard reads it when you create the app, and again on each push that [auto-deploys](/deploy/github/#auto-deploy).

The Score file describes the workload. `orchard.json` describes the build.

## Example

```yaml
apiVersion: score.dev/v1b1
metadata:
  name: web
  annotations:
    orchard.my/domain: midnight.example.com
    orchard.my/replicas: '2'
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

## Field reference

| Score field                              | Orchard result                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `containers.<first>.variables`           | The app's variables. Keys that are not in the file stay as they are.                                                                  |
| `service.ports`                          | The app's ports.                                                                                                                      |
| `resources.<name>` with `type: postgres` | [A managed database](/data/databases/) named `<name>` in the project. Orchard creates it if it is missing and connects it to the app. |
| `${resources.<name>.<field>}`            | A reference to that database, resolved when the pod starts.                                                                           |
| `orchard.my/domain`                      | [A custom domain](/deploy/domains/#add-a-custom-domain) routed to the app.                                                            |
| `orchard.my/replicas`                    | The replica count.                                                                                                                    |

Orchard deploys only the first container. `image: .` means the image Orchard builds. If you name another image, Orchard still builds from the repository.

## Database references

Orchard writes `${resources.db.connection_string}` as `${{resource.db.connection_string}}`. This is the same [reference](/deploy/connect-resources/) you get from **Use a resource** on the app's **Variables** tab. The reference follows the database through a password rotation or a restore.

These fields are available:

- `connection_string` or `url`
- `host`
- `port`
- `name` or `database`
- `username` or `user`
- `password`

If a variable references a resource the file does not provision, Orchard leaves the reference in place and reports it. The app then refuses to start.

## Limitations

- `type: redis` and `type: valkey` are recognized, but managed Valkey is not available. Orchard reports the resource and skips it.
- Orchard ignores other resource types and adds a note.
- Orchard reads `orchard.my/health-path`, but it does not set [health checks](/deploy/scaling/#set-health-checks) from Score.

## View what Orchard applied

When Orchard finds a Score file, the new app form shows the databases, ports, and domain that it sets up. Each later apply adds an entry to the [audit log](/teams/audit-logs/) with what changed.

## Related resources

- [Deploy from GitHub](/deploy/github/) - Create the app that reads the Score file, and turn on auto-deploy.
- [Score specification](https://docs.score.dev/) - Read the full Score file format.
