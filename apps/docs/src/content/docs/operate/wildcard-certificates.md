---
title: Set up wildcard certificates
description: Issue one certificate for every generated Orchard app URL with a cert-manager DNS-01 issuer and the Helm chart.
sidebar:
  order: 6
---

To cover every generated app URL with one certificate, set up a wildcard certificate. By default, each generated URL gets its own certificate from `tenant.certClusterIssuer`. Each new app then waits for an ACME request. Let's Encrypt allows 50 certificates for each registered domain per week.

Let's Encrypt only issues wildcards over a DNS-01 challenge. This guide uses `apps.example.com` as the app domain.

You do not need this guide in these cases:

- **`tunnel` mode:** Cloudflare serves the certificate for your names. For what it covers, refer to [Install Orchard](/start/install/).
- **An `sslip.io` name:** You cannot create the DNS records that DNS-01 needs. Use your own domain.

## Prerequisites

- cert-manager installed in the cluster. The installer includes it in `public` and `lan` mode.
- Your own domain, at a [DNS provider that cert-manager supports](https://cert-manager.io/docs/configuration/acme/dns01/).
- Credentials for your DNS provider.

## What the chart renders

| Template            | Renders                                                                                            | Condition                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `certificates.yaml` | A `Certificate` for `*.apps.example.com` and `apps.example.com` in `certificates.namespace`.       | `certificates.enabled`, and an app domain is set.               |
| `certificates.yaml` | A `Certificate` for `*.<db domain>`, for TLS on public databases.                                  | `certificates.enabled`, and `wildcards.db.domain` is set.       |
| `gateway.yaml`      | The `http-gateway` Gateway, with an `https-wildcard` listener that references the app certificate. | `gateway.enabled`, `gateway.http.enabled`, and a domain is set. |
| `_helpers.tpl`      | `PLATFORM_WILDCARD_DOMAINS` on the server, which names the Secret to use on each Ingress.          | An app domain or `tenant.wildcardDomains` is set.               |

The chart does not create the issuer.

Orchard routes each app through an `Ingress`, so the `https-wildcard` listener carries no app traffic. Set `gateway.http.enabled` to `false` unless something else uses that listener.

## 1. Point DNS at the cluster

Create a wildcard record for the app domain that points at your ingress controller:

```txt
*.apps.example.com  A  203.0.113.10
```

## 2. Create a DNS-01 issuer

cert-manager supports Cloudflare, Route53, AzureDNS, Google CloudDNS, DigitalOcean, Akamai, ACME-DNS, and RFC2136. For the settings of each provider, refer to the [cert-manager DNS-01 documentation](https://cert-manager.io/docs/configuration/acme/dns01/).

The following example uses Cloudflare. Create an API token with the **Zone > DNS > Edit** and **Zone > Zone > Read** permissions for your zone.

1. Create a Secret that holds the token:

   ```bash
   kubectl -n cert-manager create secret generic cloudflare-api-token \
     --from-literal=api-token=<API_TOKEN>
   ```

2. Save the issuer as `issuer.yaml`:

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

   To test without using your rate limit, set `server` to `https://acme-staging-v02.api.letsencrypt.org/directory` first. Browsers do not trust a staging certificate, so change `server` back when the test passes.

3. Apply the issuer, and check that it is ready. `READY` should be `True`.

   ```bash
   kubectl apply -f issuer.yaml
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

| Value                    | Purpose                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `appDomain`              | The wildcard that the certificate covers. Also sets `APP_DOMAIN` on the server and `PUBLIC_APP_DOMAIN` on the frontend. |
| `appWildcardSecretName`  | Moves apps onto the wildcard. Without it, the chart issues the certificate but apps keep per-host certificates.         |
| `certificates.namespace` | Where the certificate is stored. The namespace must exist. With `createNamespace: true`, the chart creates it.          |
| `copyToTenants`          | The server copies the Secret into each namespace with an Ingress that references it.                                    |

If you use `server.envFrom`, the chart does not set `APP_DOMAIN`. Add it to your Secret.

If you run a secret replicator, such as [reflector](https://github.com/emberstack/kubernetes-reflector), leave `copyToTenants` as `false`. Do not use both. Two writers on the same Secret overwrite each other.

Apply the values with `helm upgrade`. At its next reconcile, the server moves existing generated hosts onto the wildcard Secret. Custom domains keep their own certificates.

cert-manager renews the certificate 15 days before it expires. With `copyToTenants` on, the server copies the renewed Secret into each namespace.

### Installer hosts

The installer turns off `certificates.enabled` and `gateway.http.enabled`. To use a wildcard on an installer host:

1. Create the issuer as described in step 2. Run each `kubectl` command with `sudo`.
2. In `/etc/orchard/values.yaml`, change the values that exist and add the others:

   ```yaml
   gateway:
     http:
       appWildcardSecretName: wildcard-apps-example-com-tls

   certificates:
     enabled: true
     copyToTenants: true
   ```

3. Apply the change:

   ```bash
   sudo orchardctl update
   ```

### Dashboard settings

**Instance admin** > **Configuration** > **Wildcard certificate** edits the same mapping. A value that comes from the chart is locked, and the dashboard shows what to change instead. Use this page when you manage the Secret yourself and the chart does not set the value.

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

Check each resource in order. The challenge status shows what the DNS provider or Let's Encrypt returned.

```bash
kubectl -n network describe certificate wildcard-apps-example-com-tls
kubectl -n network get certificaterequest,order,challenge
kubectl -n network describe challenge
```

### The Secret is missing from the app namespace

Check that `copyToTenants` is on, or that your replicator covers that namespace.

## Related resources

- [Use a wildcard certificate](/operate/finishing-setup/#use-a-wildcard-certificate)
- [Manage domains and HTTPS](/deploy/domains/)
