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

From the CLI: `orchard template list`, then `orchard template deploy <id>`.

## Writing one

A template is one YAML file with three sections: `metadata` describes it,
`parameters` are the questions Orchard asks before deploying, and `resources`
are what gets created, in order.

```yaml
apiVersion: leaf/v1
kind: Template
metadata:
  name: ghost
  displayName: Ghost Blog
  description: Ghost with a PostgreSQL database and a public domain.
  version: '1.0.0'
  category: cms
  tags: ['blog', 'cms']
  author: LeafdTK

parameters:
  - name: appName
    displayName: App Name
    type: string
    default: ghost
    required: true
    validation:
      pattern: '^[a-z][a-z0-9-]{1,58}[a-z0-9]$'
      message: Lowercase letters, digits and hyphens, 3 to 60 characters
  - name: domain
    displayName: Domain
    type: string
    required: true
    placeholder: blog.example.com
  - name: enableTls
    displayName: Enable HTTPS
    type: boolean
    default: true

resources:
  - name: db
    type: database
    config:
      name: '{{ params.appName }}-db'

  - name: app
    type: deployment
    config:
      name: '{{ params.appName }}'
      image: ghost:5
      ports:
        - name: http
          containerPort: 2368
          servicePort: 2368
          protocol: TCP
      env:
        - key: database__client
          value: postgres
        - key: database__connection__host
          value: '{{ resources.db.host }}'
        - key: database__connection__password
          value: '{{ resources.db.dbPassword }}'
          secret: true
        - key: url
          value: 'https://{{ params.domain }}'

  - name: ingress
    type: ingress
    config:
      host: '{{ params.domain }}'
      tlsEnabled: '{{ params.enableTls }}'
      routes:
        - path: /
          serviceName: '{{ resources.app.serviceName }}'
          servicePort: 2368
```

### Metadata

| Field         | Required | Notes                                                                  |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `name`        | yes      | Lowercase letters, digits and hyphens. Unique on the instance.         |
| `displayName` | no       | Shown in the UI. Defaults to `name`.                                   |
| `description` | no       | One or two sentences.                                                  |
| `version`     | registry | A semantic version. Required to publish to the registry.               |
| `category`    | no       | Groups templates in the gallery, for example `cms` or `database`.      |
| `tags`        | no       | A list of strings, searchable.                                         |
| `keywords`    | no       | Extra search terms: what someone types when they do not know the name. |
| `icon`        | no       | An icon name for the UI.                                               |
| `author`      | no       | Your GitHub login. The gallery credits you with it.                    |
| `homepage`    | no       | An `https://` link to the software's site.                             |
| `license`     | no       | SPDX id of the software the template deploys, shown on its page.       |

### Parameters

Every parameter needs a `name`. Everything else is optional.

| Field         | Notes                                                                                                                                                                                    |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `displayName` | The label in the form. Defaults to `name`.                                                                                                                                               |
| `description` | Help text under the field.                                                                                                                                                               |
| `type`        | `string` (default), `number`, `boolean`, `select` or `secret`.                                                                                                                           |
| `default`     | Used when the field is left empty.                                                                                                                                                       |
| `required`    | Rejects an empty value that has no default.                                                                                                                                              |
| `placeholder` | Hint text in the empty field.                                                                                                                                                            |
| `options`     | For `select`: a list of `{ label, value }`. The value must be one of them.                                                                                                               |
| `validation`  | `pattern` and `message` for strings; `min` and `max` for numbers and secret lengths; `bytes` and `encoding` (`hex` or `base64`) for generated secrets that must decode to an exact size. |

Types matter at deploy time:

- **string** values are checked against `validation.pattern` if there is one. A
  parameter that names a resource (`name`, `appName`, anything ending in `Name`)
  is slugified first, so "My Blog" becomes `my-blog` instead of failing.
- **number** values are coerced and checked against `min` and `max`.
- **boolean** accepts `true` or the string `"true"`.
- **select** must match one of the option values.
- **secret** is generated when left blank: a random hex string, 32 characters
  long or `validation.min` if that is larger. Use it for admin passwords and
  signing keys so the user does not have to invent one.

### Resources

Resources are created top to bottom, and each one can reference the ones above
it. The `name` is how later resources refer to it; the `type` decides which
`config` keys apply.

**database** creates a PostgreSQL database.

| Config     | Notes                            |
| ---------- | -------------------------------- |
| `name`     | Required.                        |
| `replicas` | Read replicas. Defaults to none. |

It exposes `host`, `port`, `dbName`, `dbUser`, `dbPassword` and
`connectionString` (a full `postgresql://` URL) to later resources.

**deployment** creates an app, either from an image or by building a
repository.

| Config                                                                               | Notes                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                                                                               | Required.                                                                                                                                                                                                                 |
| `image`                                                                              | Deploy this image. Use this or `repo`.                                                                                                                                                                                    |
| `repo`, `branch`                                                                     | Build from a Git repository instead.                                                                                                                                                                                      |
| `buildType`                                                                          | `dockerfile` (default, with `dockerfilePath`) or `railpack`.                                                                                                                                                              |
| `rootDirectory`, `installCommand`, `buildCommand`, `startCommand`, `outputDirectory` | Build settings for repository builds. `startCommand` also applies to images.                                                                                                                                              |
| `replicas`                                                                           | Defaults to 1.                                                                                                                                                                                                            |
| `ports`                                                                              | A list of `{ name, containerPort, servicePort, protocol, public }`. `public: true` publishes that port on the organization's external IP over raw TCP or UDP, which is how a game server or a database client reaches it. |
| `env`                                                                                | A list of `{ key, value }`. Add `secret: true` to store the value as a secret.                                                                                                                                            |
| `volumes`                                                                            | Persistent volumes, same shape as the API accepts.                                                                                                                                                                        |
| `exposePublic`                                                                       | Create the Service as a NodePort instead of ClusterIP. Prefer `public: true` on a port.                                                                                                                                   |
| `autoDeploy`, `autoDeployBranch`                                                     | Redeploy on push, for repository builds.                                                                                                                                                                                  |

It exposes `serviceName`, which is what an ingress route points at. A deployment
with a published port also exposes `publicIp`, `publicPort` and `publicHost`;
the public port number is assigned by the instance, not chosen by the template.

**ingress** puts a domain in front of a deployment.

| Config                               | Notes                                                  |
| ------------------------------------ | ------------------------------------------------------ |
| `host`                               | Required. The domain.                                  |
| `tlsEnabled`                         | Defaults to `true`.                                    |
| `routes`                             | A list of `{ path, serviceName, servicePort }`.        |
| `path`, `serviceName`, `servicePort` | Shorthand for a single route when `routes` is omitted. |
| `basicAuth`                          | Protect the domain with a username and password.       |

It exposes `host`.

### Expressions

Two forms, and nothing else:

- `{{ params.<name> }}` reads a parameter.
- `{{ resources.<name>.<field> }}` reads a field exposed by an earlier resource.

A value that is exactly one expression keeps its type, so
`replicas: '{{ params.replicas }}'` stays a number and
`tlsEnabled: '{{ params.enableTls }}'` stays a boolean. Anything longer is
string interpolation: `'https://{{ params.domain }}'`. Referencing a resource
that is defined further down fails at deploy time.

:::caution
Deploy a template end to end before publishing it. A template that references
software with a database it cannot actually use will deploy cleanly and then
crash-loop, which is a much worse experience than a template that does not exist.
:::

## Instances

A template instance keeps track of the resources it created and their status.
Deleting the instance offers to delete everything it made.

## The community registry

The templates that ship with Orchard, and the ones the community has
contributed, are published to a public registry at `https://orchard.my/registry`
and shown in the gallery at [orchard.my/templates](https://orchard.my/templates).

An instance pulls the catalogue on boot and every six hours when
`TEMPLATE_REGISTRY_URL` is set. Imported templates are protected like built-in
ones: they cannot be edited or deleted from the instance, and a custom template
that already uses a name is never overwritten. Leave the variable empty on an
air-gapped instance; the built-in templates still seed from the server image.

### Publishing one

1. Add `registry/templates/<name>.yaml` to the
   [Orchard repository](https://github.com/hackclub/orchard/tree/main/registry).
   The file name must match `metadata.name`, and `metadata.version` is required.
   A `<name>.md` next to it is rendered on the template's page and a 1200x675
   `<name>.png` is its preview in the gallery.
2. Check it locally:

   ```sh
   go run ./apps/registry validate -templates registry/templates
   ```

3. Commit as `feat(templates): add <name>` and open a pull request. CI runs the
   same validator, and a merge publishes it within a minute.

Published versions are immutable, so bump `metadata.version` to ship a change.
Every version stays fetchable:

```
https://orchard.my/registry/templates/index.json
https://orchard.my/registry/templates/<name>/index.json
https://orchard.my/registry/templates/<name>/<version>/template.yaml
https://orchard.my/registry/templates/<name>/latest/template.yaml
```
