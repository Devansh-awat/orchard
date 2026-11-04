---
title: Set up wildcard certificates
description: Issue one certificate for every generated Orchard app URL with a cert-manager DNS-01 issuer and the Helm chart.
sidebar:
  order: 6
---

To cover every generated app URL with one certificate, set up a wildcard certificate. By default, each generated URL gets its own certificate from `tenant.certClusterIssuer`. Each new app then waits for an ACME request. Let's Encrypt allows 50 certificates for each registered domain per week.

Let's Encrypt only issues wildcards over a DNS-01 challenge. This guide uses `apps.example.com` as the app domain.

## Prerequisites

- cert-manager is installed in the cluster.
- You have credentials for your DNS provider.

## What the chart renders

| Template            | Renders                                                                                             | Condition                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `certificates.yaml` | A `Certificate` for `*.apps.example.com` and `apps.example.com` in `certificates.namespace`.        | `certificates.enabled`, and an app domain is set.           |
| `certificates.yaml` | A `Certificate` for `*.<db domain>`, for TLS on public databases.                                   | `certificates.enabled`, and `wildcards.db.domain` is set.   |
| `gateway.yaml`      | The `http-gateway` Gateway, with an `https-wildcard` listener that references the app certificate.  | `gateway.enabled`, `gateway.http.enabled`, and a domain is set. |
| `_helpers.tpl`      | `PLATFORM_WILDCARD_DOMAINS` on the server, which names the Secret to use on each Ingress.           | An app domain or `tenant.wildcardDomains` is set.           |

The chart does not create the issuer.

Orchard routes each app through an `Ingress`, so the `https-wildcard` listener carries no app traffic. Set `gateway.http.enabled` to `false` unless something else uses that listener.

## 1. Point DNS at the cluster

Create a wildcard record for the app domain that points at your ingress controller:

```txt
*.apps.example.com  A  203.0.113.10
```

## 2. Create a DNS-01 issuer

cert-manager supports Cloudflare, Route53, AzureDNS, Google CloudDNS, DigitalOcean, Akamai, ACME-DNS and RFC2136. The following example uses Cloudflare, with an API token that can edit DNS in the zone.

1. Create a Secret that holds the token:

   ```bash
   kubectl -n cert-manager create secret generic cloudflare-api-token \
     --from-literal=api-token=<API_TOKEN>
   ```

2. Create the issuer:

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

   The chart looks for the name `letsencrypt-dns01-wildcard`. To use another issuer, set `certificates.issuer.name` and `certificates.issuer.kind`.

3. Check that the issuer is ready:

   ```bash
   kubectl get clusterissuer letsencrypt-dns01-wildcard
   ```

## 3. Set the chart values

Add the following to your values file:

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

| Value                   | Purpose                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| `appDomain`             | The wildcard that the certificate covers. Also sets `APP_DOMAIN` on the server and `PUBLIC_APP_DOMAIN` on the frontend. |
| `appWildcardSecretName` | Moves apps onto the wildcard. Without it, the chart issues the certificate but apps keep per-host certificates. |
| `certificates.namespace` | Where the certificate is stored. The namespace must exist. With `createNamespace: true`, the chart creates it. |
| `copyToTenants`         | The server copies the Secret into each namespace with an Ingress that references it.                       |

If you use `server.envFrom`, the chart does not set `APP_DOMAIN`. Add it to your Secret.

If you run a secret replicator, such as [reflector](https://github.com/emberstack/kubernetes-reflector), leave `copyToTenants` as `false`. Do not use both. Two writers on the same Secret overwrite each other.

Apply the values with `helm upgrade`. At its next reconcile, the server moves existing generated hosts onto the wildcard Secret.

### Installer hosts

The installer sets `certificates.enabled` to `false` and `gateway.http.enabled` to `false`. To use a wildcard on an installer host, set `certificates.enabled` to `true` in `/etc/orchard/values.yaml`, add the values above, and run `sudo orchardctl update`.

### Several domains

For more than one wildcard, or a Secret that you manage yourself, set the mapping directly. It takes precedence over the derived value. The chart only issues certificates for the app domain and the database domain, so you provide the Secret for any other domain.

```yaml
tenant:
  wildcardDomains: .apps.example.com=wildcard-apps-tls,.preview.example.com=wildcard-preview-tls
```

### Public databases

To use a wildcard for public database connections, name the domain and point the server at the same Secret. The domain must match `PUBLIC_DB_DOMAIN` on the server.

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

## 4. Verify the certificate

1. Check that the certificate was issued. `READY` should be `True`.

   ```bash
   kubectl -n network get certificate
   kubectl -n network get secret wildcard-apps-example-com-tls
   ```

2. Check that the server has the mapping:

   ```bash
   kubectl -n orchard exec deploy/server -- printenv PLATFORM_WILDCARD_DOMAINS
   ```

   The output should be as follows:

   ```txt
   .apps.example.com=wildcard-apps-example-com-tls
   ```

3. Check an app. Its namespace should have a copy of the Secret, and the subject should be `CN=*.apps.example.com`.

   ```bash
   kubectl -n <APP_NAMESPACE> get secret wildcard-apps-example-com-tls
   kubectl -n <APP_NAMESPACE> get ingress -o yaml | grep secretName
   curl -vI https://<APP_HOST> 2>&1 | grep -E 'subject:|issuer:'
   ```

## Troubleshoot the certificate

### The certificate stays `False`

Follow the chain down. The challenge status shows what the DNS provider or Let's Encrypt returned.

```bash
kubectl -n network describe certificate wildcard-apps-example-com-tls
kubectl -n network get certificaterequest,order,challenge
kubectl -n network describe challenge
```

### The Secret is missing from the app namespace

Check that `copyToTenants` is on, or that your replicator covers that namespace.

## Related resources

- [Use a wildcard certificate](/operate/finishing-setup/#use-a-wildcard-certificate)
- [Domains and HTTPS](/deploy/domains/)
