---
title: Finishing setup
description: The checklist on the admin overview, and how to satisfy each item.
sidebar:
  order: 3
---

A fresh instance works the moment you claim it. The checklist on
**Instance admin → Overview** is everything that is still switched off.

None of it blocks deploying. Each item turns something on, and the one marked
with a warning triangle is the one you should not leave alone.

Most of it is editable at **Instance admin → Configuration**, and takes effect
immediately without a restart.

Every item follows the same rule: **an environment variable always wins over a
value stored in the database.** Setting the matching variable locks that field
so nobody can change it from the browser, which is what you want for anything an
operator must control absolutely. A field set that way is shown greyed out and
labelled `Set by the environment`.

Secrets are encrypted at rest and never sent back to the browser. An existing
secret shows as `Unchanged`, and leaving it blank keeps what is already stored,
so changing a bucket name does not mean retyping a key.

## Connect a GitHub App

Lets Orchard deploy private repositories and rebuild when you push.

The quickest path is **Instance admin → Overview → Connect a GitHub App**, which
uses GitHub's manifest flow: you press a button, GitHub asks you to confirm, and
it hands the App's credentials back. Orchard registers the callback URL, webhook
URL and permissions for you. Nothing to copy by hand.

If you would rather register the App yourself, its **Callback URL** must be
exactly:

```
https://your-orchard-host/apiv1/github/callback
```

Orchard shows the value it expects on the same page. Getting this wrong is what
produces GitHub's `The redirect_uri is not associated with this application`
error, and it is worth checking character for character: scheme, port, and no
trailing slash.

Orchard derives that URL from `FRONTEND_URL`. If your public origin differs from
`FRONTEND_URL`, for example because a proxy terminates TLS on a different
hostname, override it:

| Variable | Purpose |
| --- | --- |
| `GITHUB_APP_ID` | numeric App ID |
| `GITHUB_APP_SLUG` | the App's URL slug |
| `GITHUB_APP_PRIVATE_KEY` | PEM contents, `\n` for newlines |
| `GITHUB_APP_WEBHOOK_SECRET` | webhook signing secret |
| `GITHUB_CLIENT_ID` | OAuth client ID |
| `GITHUB_CLIENT_SECRET` | OAuth client secret |
| `GITHUB_REDIRECT_URI` | overrides the derived callback URL |

Set any of these and the matching field becomes read-only in the UI.

## Configure database backups

This is the warning-severity item, and the wording is literal: **until object
storage is configured, managed databases have no base backup at all.** Write
ahead log archiving alone cannot restore a database that has been deleted,
because there is no base to replay onto.

| Variable | Purpose |
| --- | --- |
| `R2_ACCESS_KEY_ID` | S3-compatible access key |
| `R2_SECRET_ACCESS_KEY` | secret key |
| `R2_BUCKET_NAME` | bucket backups are written to |
| `R2_ENDPOINT` | S3 endpoint, for example the R2 or MinIO URL |
| `R2_ACCOUNT_ID` | Cloudflare account ID, R2 only |
| `R2_PUBLIC_URL` | public base URL, used for build context and assets |

The checklist counts this item done once `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` and `R2_BUCKET_NAME` are all set.

Any S3-compatible store works. `R2_ENDPOINT` and `R2_PUBLIC_URL` are derived
from the account ID when left blank.

After setting these, confirm a fresh backup appears under a database's Backups
tab before you trust it. A backup you have never seen complete is not a backup.

## Set up email

Needed for invitation emails and sign-in codes.

| Variable | Purpose |
| --- | --- |
| `SMTP_HOST` | mail server hostname |
| `SMTP_PORT` | usually 587 |
| `SMTP_USER` | username |
| `SMTP_PASS` | password |
| `SMTP_SECURE` | `true` for implicit TLS, port 465 |
| `SMTP_FROM` | address mail is sent from |
| `SMTP_FROM_NAME` | display name on outgoing mail |

The checklist counts this item done as soon as `SMTP_HOST` is set, so set the
rest at the same time or mail will fail at send rather than at boot.

Without SMTP the product still works. Invitations become copyable links you send
yourself, and you sign in with a passkey rather than an emailed code. On a single
operator instance that is often the right choice: skip it deliberately rather
than leaving it half configured.

## Add an identity provider

Lets people sign in through your existing SSO instead of a passkey or emailed
code. Configure it at **Instance admin → Sign in**, or pin it with environment
variables.

| Variable | Purpose |
| --- | --- |
| `AUTH_OAUTH_CLIENT_ID` | client ID from your IdP |
| `AUTH_OAUTH_CLIENT_SECRET` | client secret |
| `AUTH_OAUTH_REDIRECT_URI` | `https://your-orchard-host/apiv1/auth/oauth/callback` |
| `AUTH_OAUTH_ISSUER` | issuer URL, for discovery |
| `AUTH_OAUTH_AUTHORIZE_URL` | set these three instead of an issuer if discovery is unavailable |
| `AUTH_OAUTH_TOKEN_URL` | |
| `AUTH_OAUTH_USERINFO_URL` | |
| `AUTH_OAUTH_SCOPES` | defaults to `openid profile email` |
| `AUTH_OAUTH_CLAIM_ID` | claim mapping, defaults to `sub` / `email` / `name` |

Any OIDC provider works: Keycloak, Authentik, Dex, Okta, Google.

Keep one passkey on the superadmin account after enabling SSO. If the IdP goes
down and it is the only way in, you are locked out of your own instance.

## Set the ingress CNAME

The hostname users point their own domains at with a CNAME record.

| Variable | Purpose |
| --- | --- |
| `INGRESS_CNAME` | for example `ingress.your-orchard-host` |

Leave it unset and custom domains still work, but Orchard cannot check whether
DNS points at the cluster before issuing a certificate, so it skips validation
and people find out it was wrong when the certificate fails instead.

## Use a wildcard certificate

By default every generated app URL gets its own certificate. Let's Encrypt allows
**50 certificates per registered domain per week**, so an instance handing out
`*.apps.example.com` URLs starts failing to issue somewhere north of fifty apps,
and the limit refills slowly.

A wildcard certificate removes the ceiling: one certificate covers every
subdomain.

| Variable | Purpose |
| --- | --- |
| `PLATFORM_WILDCARD_DOMAINS` | `.apps.example.com=wildcard-tls`, comma separated for several |
| `WILDCARD_TLS_SOURCE_NAMESPACE` | namespace holding the certificate secret |

The suffix before `=` is the domain, the name after it is the Kubernetes secret
holding the certificate. Without a secret name Orchard still generates URLs, but
serves them without TLS.

Wildcards require a **DNS-01** challenge, so cert-manager needs an issuer with
credentials for your DNS provider. Cloudflare, Route53, AzureDNS, Google
CloudDNS, DigitalOcean, Akamai, ACME-DNS and RFC2136 all have native support.
HTTP-01 cannot issue a wildcard.

Tenant namespaces need their own copy of the secret. Either run
[reflector](https://github.com/emberstack/kubernetes-reflector) and annotate the
source secret, or let Orchard copy it by setting `certificates.copyToTenants` in
the chart. Do not do both: two writers on the same secret will fight.

## When cert-manager is not installed

Orchard does not require it. If the CRDs are absent, or the service account
cannot read them, the certificate step reports **No certificate automation** and
setup continues. Terminate TLS wherever you already do, at your load balancer or
proxy, and ignore the wildcard item.
