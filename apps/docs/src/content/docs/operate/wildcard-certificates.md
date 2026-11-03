---
title: Wildcard certificates
description: Issue one certificate for every generated app URL with a DNS-01 issuer and the Helm chart.
sidebar:
  order: 6
---

By default every generated app URL gets its own certificate from
`tenant.certClusterIssuer`. That works with no extra setup, but each new app waits
on an ACME round-trip, and Let's Encrypt allows 50 certificates per registered
domain per week.

A wildcard certificate covers every subdomain of your app domain at once. Let's
Encrypt only issues wildcards over a DNS-01 challenge, so you need cert-manager and
credentials for your DNS provider.

This guide uses `apps.example.com` as the app domain.

## What the chart does

| Template            | What it renders                                                                                   | Rendered when                                               |
| ------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `certificates.yaml` | A `Certificate` for `*.apps.example.com` and `apps.example.com` in `certificates.namespace`       | `certificates.enabled`, and an app domain is set            |
| `certificates.yaml` | A `Certificate` for `*.<db domain>`, used for TLS on public databases                             | `certificates.enabled`, and `wildcards.db.domain` is set    |
| `gateway.yaml`      | The `http-gateway` Gateway, with an `https-wildcard` listener that references the app certificate | `gateway.enabled`, `gateway.http.enabled`, and a domain set |
| `_helpers.tpl`      | `PLATFORM_WILDCARD_DOMAINS` on the server, which tells it which Secret to put on each Ingress     | An app domain or `tenant.wildcardDomains` is set            |

The chart does not create the issuer. cert-manager has to be installed and the
issuer has to exist before the `Certificate` can be issued.

Orchard routes every app through an `Ingress`, not an `HTTPRoute`, so the
`https-wildcard` listener carries no app traffic. Turn it off with
`gateway.http.enabled: false` unless something else of yours attaches to it.

## 1. Point DNS at the cluster

Create a wildcard record for the app domain that points at your ingress controller.

```text
*.apps.example.com  A  203.0.113.10
```

## 2. Create a DNS-01 issuer

cert-manager supports Cloudflare, Route53, AzureDNS, Google CloudDNS, DigitalOcean,
Akamai, ACME-DNS and RFC2136 natively. This example uses Cloudflare, with an API
token that can edit DNS in the zone.

```bash
kubectl -n cert-manager create secret generic cloudflare-api-token \
  --from-literal=api-token=<token>
```

```yaml
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns01-wildcard
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: you@example.com
    privateKeySecretRef:
      name: letsencrypt-dns01-wildcard-account
    solvers:
      - dns01:
          cloudflare:
            apiTokenSecretRef:
              name: cloudflare-api-token
              key: api-token
```

`letsencrypt-dns01-wildcard` is the name the chart looks for. To use another issuer,
set `certificates.issuer.name` and `certificates.issuer.kind`.

Check that the issuer is ready before you go on:

```bash
kubectl get clusterissuer letsencrypt-dns01-wildcard
```

## 3. Set the chart values

```yaml
gateway:
  http:
    enabled: false
    appDomain: apps.example.com
    appWildcardSecretName: wildcard-apps-example-com-tls

certificates:
  enabled: true
  namespace: network
  copyToTenants: true
```

- `appDomain` sets the wildcard the certificate covers. It also sets the server's
  `APP_DOMAIN` and the frontend's `PUBLIC_APP_DOMAIN`. If you use `server.envFrom`,
  the chart leaves `APP_DOMAIN` to you, so set it in that Secret too.
- `appWildcardSecretName` is what moves apps onto the wildcard. Without it the chart
  still issues the certificate, but `PLATFORM_WILDCARD_DOMAINS` names no Secret, so
  apps keep getting per-host certificates. With it empty, the certificate is stored
  in `wildcard-<domain with dots as dashes>-tls`.
- `certificates.namespace` must exist. With `createNamespace: true` the chart creates
  it.
- `copyToTenants` makes the server copy the Secret into every namespace whose
  ingresses reference it. An `Ingress` can only read a Secret in its own namespace.
  If you already run a secret replicator such as
  [reflector](https://github.com/emberstack/kubernetes-reflector), leave this `false`
  and have it copy the Secret. Do not use both: two writers on the same Secret
  overwrite each other forever.

On a one-command install, the values live in `/etc/orchard/values.yaml`. The
installer sets `certificates.enabled: false`, so change that too, then apply with
`orchard-update`.

Apply the values with `helm upgrade`. On its next reconcile the server moves
existing generated hosts onto the wildcard Secret.

### Several domains

For more than one wildcard, or a Secret you manage yourself, set the mapping
directly. It takes precedence over the derived value.

```yaml
tenant:
  wildcardDomains: .apps.example.com=wildcard-apps-tls,.preview.example.com=wildcard-preview-tls
```

The chart only issues a certificate for the app domain and the database domain. You
provide the Secret for anything else.

### Public databases

To use a wildcard for public database connections, name the domain and tell the
server to read from the same Secret. The domain has to match `PUBLIC_DB_DOMAIN` on
the server.

```yaml
certificates:
  wildcards:
    db:
      enabled: true
      domain: db.example.com
      secretName: wildcard-db-example-com-tls

publicTls:
  db:
    sourceSecret: wildcard-db-example-com-tls
```

## 4. Verify

Check that the certificate was issued. `READY` should be `True`.

```bash
kubectl -n network get certificate
kubectl -n network get secret wildcard-apps-example-com-tls
```

If it stays `False`, follow the chain down. The challenge's status says what the
DNS provider or Let's Encrypt returned.

```bash
kubectl -n network describe certificate wildcard-apps-example-com-tls
kubectl -n network get certificaterequest,order,challenge
kubectl -n network describe challenge
```

Check that the server picked it up:

```bash
kubectl -n orchard exec deploy/server -- printenv PLATFORM_WILDCARD_DOMAINS
```

This should print `.apps.example.com=wildcard-apps-example-com-tls`.

Deploy an app, or look at one you already have, then check its namespace has a copy
of the Secret and the URL serves the wildcard:

```bash
kubectl -n <app namespace> get secret wildcard-apps-example-com-tls
kubectl -n <app namespace> get ingress -o yaml | grep secretName
curl -vI https://<app host> 2>&1 | grep -E 'subject:|issuer:'
```

The subject should be `CN=*.apps.example.com`. If the Secret is missing from the app's
namespace, check that `copyToTenants` is on, or that your replicator covers that
namespace.
