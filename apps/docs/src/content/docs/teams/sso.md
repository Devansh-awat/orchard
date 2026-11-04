---
title: Set up SSO
description: Add an OIDC or SAML identity provider to an Orchard organization, verify email domains, and require single sign-on.
sidebar:
  order: 2
---

To let members sign in with your identity provider, add a connection to your organization. Orchard supports OpenID Connect (OIDC) and Security Assertion Markup Language (SAML) 2.0. An organization can have more than one connection.

Sessions created through an organization's SSO connection can only reach that organization.

## Prerequisites

- SSO allowed for your organization. SSO is off for every organization until a superadmin allows it at **Instance admin** > **Sign in**.
- The **Owner** [role](/teams/organizations/#organization-roles) in the organization. Admins can view SSO settings but cannot change them.

## Add a connection

1. Go to **Organization settings** > **SSO**.
2. In **Connections**, select **Add connection**.
3. Select a provider. Orchard has presets for Google Workspace, Microsoft Entra ID, GitHub, GitLab, Okta, Auth0, Keycloak, Authentik, OneLogin, and JumpCloud. For another provider, select **OpenID Connect** or **SAML 2.0**.
4. Enter the provider details:
   - For OIDC, enter the **Client ID** and **Client secret**, plus the **Issuer URL** or provider domain if the form asks for one.
   - For SAML, enter the **IdP metadata URL**, or the **Sign-in URL**, **IdP entity ID**, and **Signing certificate**.
5. In **Who this lets in**, set the following options:
   - **Create accounts on first sign-in:** When this is off, only people with an account or a pending invitation can use the connection.
   - **Require a verified email:** Orchard rejects sign-ins where the provider does not vouch for the address.
   - **Role for new members:** Select **Member**, **Admin**, or **Guest**.
   - **Email domains:** Leave this blank to accept any address.
   - **Show on the sign-in page:** Turn on to list the connection on the sign-in page.
6. Save the connection.
7. Open the connection again.
8. Copy the values under **Give these to your identity provider** to your provider. OIDC uses the **Redirect URL**. SAML uses the **Entity ID** and **SP metadata**.

## Test the connection

1. In **Connections**, select **More** on the connection row.
2. Select **Test connection**.

A successful test shows `Reached the provider`.

## Turn on single sign-on

1. In **Single sign-on**, turn on **Use single sign-on**. The option is unavailable until a working connection is turned on.
2. Copy the **Sign-in page** address.
3. Open the address in a private browser window.
4. Sign in with a test account.

The sign-in page shows your connections and branding, so members do not choose from every provider on the instance.

## Verify an email domain

Verified domains send work email addresses to your sign-in page and let your connections create accounts for new people. Until you verify a domain, people join by invitation.

1. In **Email domains**, enter the domain in **Add a domain**, such as `example.com`.
2. Select **Add**.
3. Add the TXT record that Orchard shows at your DNS provider. The record name starts with `_orchard-challenge`.
4. Select **Check DNS**.

The domain status changes from **Pending** to **Verified**.

## Require single sign-on

Requiring single sign-on applies at two levels, depending on who owns the member's email domain.

| Member                                                           | Effect                                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Email on one of your [verified domains](#verify-an-email-domain) | Orchard blocks email codes, passkeys, passwords, and instance providers for the whole account, and signs out sessions that used them.       |
| Any other email                                                  | The person keeps their Orchard account and their other organizations. They need your provider to open this organization. Owners are exempt. |

Your provider can only sign in as an existing account if its email is on a verified domain, or the person started the sign-in from their own Orchard session. Otherwise Orchard asks them to sign in to Orchard first.

:::caution
Test a connection before you turn this on. A provider that fails blocks members on your verified domains from Orchard, and every other member except owners from this organization. Superadmins are never blocked.
:::

1. In **Single sign-on**, turn on **Require single sign-on**.

Superadmins can still sign in without SSO, so that a broken provider does not lock the instance.

## Customize the sign-in page

1. In **Sign-in page**, enter a **Logo** URL, **Heading**, and **Subheading**.
2. Select the **Accent** and **Background** colors.
3. Select **Save**.
4. Select **Preview** to review the page.

## Set a vanity address

A vanity address sends visitors at `<subdomain>.<base domain>` to your sign-in page. The **Vanity address** section appears for owners when the instance has `BASE_DOMAIN` set.

1. In **Vanity address**, enter a **Subdomain**.
2. Select **Save**.

Orchard creates an Ingress and a certificate for the host. If the organization has no working SSO connection, visitors to the address go to the default sign-in page.

## Set up instance providers

To offer a provider to everyone on the instance sign-in page, a superadmin can go to **Instance admin** > **Sign in**. The same page has **Require single sign-on for everyone**, which stops email codes, passkeys, and the superadmin password for everyone except superadmins.

To set a provider through environment variables, refer to [Add an identity provider](/operate/finishing-setup/#add-an-identity-provider).

## Related resources

- [Set up SCIM provisioning](/teams/scim/)
- [Manage organizations and roles](/teams/organizations/)
- [Configuration](/operate/configuration/#base-domain)
- [Manage sign-in and sessions](/account/security/)
