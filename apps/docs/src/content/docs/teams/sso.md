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

### SAML requirements

SAML sign-in is always started from Orchard. Orchard rejects responses that your provider starts on its own (IdP-initiated sign-in), responses that are not signed on both the response and the assertion, SHA-1 signatures, and responses whose issuer is not the **IdP entity ID** you saved. The entity ID is required. A connection saved before it was required gets it filled in automatically from its stored metadata URL, as long as that metadata lists the saved signing certificate. Without a metadata URL, sign-in is refused until an admin enters the entity ID. Orchard verifies signatures only against the signing certificate saved on the connection, so after your provider rotates its certificate, paste the new one into the connection. Your provider must sign with RSA or ECDSA and SHA-256 or stronger, and set the assertion's `Recipient` and the response's `Destination` to the **Redirect URL** shown on the connection.

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

Requiring single sign-on also applies to API tokens and [MCP connections](/mcp/). One made without your provider can't reach this organization and gets a `403` with the error `org_sso_required`. It keeps working in the person's other organizations. Owners and superadmins are exempt.

To regain access, members sign in through your provider, then create a new [API token](/account/tokens/#tokens-and-single-sign-on) or reconnect their MCP client. Scripts and CI jobs that use an older token stop working in this organization until someone replaces it.

[Deployment webhooks](/run/webhooks/) and [SCIM](/teams/scim/) tokens are not tied to anyone's sign-in, and keep working.

Your provider can only sign in as an existing account that is already a member of the organization, and only if its email is on a verified domain, or the person started the sign-in from their own Orchard session and Orchard has verified that email. An account with an unverified email is never linked from a session, so it needs a verified domain. Otherwise Orchard asks them to sign in to Orchard first. A provider can create a brand-new account only inside a verified domain.

A session opened through an organization's provider is confined to that organization. It can't browse the person's personal GitHub repositories or installations, link accounts, or manage their account.

:::caution
Test a connection before you turn this on. A provider that fails blocks members on your verified domains from Orchard, and every other member except owners from this organization. Superadmins are never blocked. Replace the API tokens your scripts and CI jobs use before you turn this on.
:::

1. In **Single sign-on**, turn on **Require single sign-on**.

Superadmins can still sign in without SSO, so that a broken provider does not lock the instance.

## Start sign-in from your provider's app tile

Orchard does not accept sign-ins that your provider starts on its own, so a SAML app tile cannot post a response straight to Orchard. Point the tile at Orchard instead, and Orchard sends the person to your provider and back with a request it can match to the response.

1. Find the connection ID in the `id` field of `GET /apiv1/organizations/<organization id>/sso/providers`.
2. Build the start address: `https://<your Orchard host>/apiv1/sso/start/<connection id>`.
3. In your provider, set the app's start URL, bookmark URL, or sign-on URL to that address. In Okta this is the **Initiate login URI** or a bookmark app. In Microsoft Entra ID it is the application's **Home page URL**. In Google Workspace use the **Start URL**.
4. Keep Orchard's **Redirect URL** as the assertion consumer service (ACS) URL.

The person lands on your provider, signs in if they have no session, and is returned to Orchard. Add `?returnTo=/path` to the start URL to land on a specific page.

## Map provider groups to roles

By default every person your connection creates gets the **Role for new members**, and nothing changes it afterward. Group rules replace that with a mapping from your provider's groups to organization roles that Orchard re-checks at every sign-in.

Group rules work with OIDC and SAML connections. OAuth 2.0 connections cannot carry groups.

Group rules are managed through the API in this release. The dashboard does not show them yet.

1. Make your provider send group names. Refer to [Provider notes](#provider-notes).
2. Preview a set of group names against the saved rules. The response lists the role each group set gives and whether the person would be let in:

   ```sh
   curl -X POST "$ORCHARD/apiv1/organizations/$ORG/sso/providers/$CONNECTION/rules/preview" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"groups":["eng","leads"]}'
   ```

3. Replace the connection's rules and set the claim that holds the groups. `groupClaim` defaults to `groups`, and for OIDC it can be a dotted path such as `realm_access.roles`. Each rule is one exact group name and a role of `admin`, `member`, or `guest`. Only owners can do this.

   ```sh
   curl -X PUT "$ORCHARD/apiv1/organizations/$ORG/sso/providers/$CONNECTION/rules" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"groupClaim":"groups","rules":[{"value":"eng","role":"member"},{"value":"leads","role":"admin"}]}'
   ```

   The call replaces the whole rule set, up to 1,000 rules. `GET` on the same path returns the current rules.

These rules apply:

- A rule can never give **Owner**. Owners are managed in Orchard, and a rule never changes or removes one.
- Group names match exactly after Unicode normalization (NFC) and trimming. Case matters: `Admins` does not match `admins`. Rule names that mix Latin, Cyrillic, or Greek letters, or that contain invisible characters, are rejected so that lookalike names cannot be confused.
- A person in several mapped groups gets the highest role.
- Once a connection has any rule, a person who matches none is denied at sign-in and no account is created. To stop using rules, remove all of them.
- Roles are re-evaluated at every sign-in. When a person's role drops, or a person who rules added no longer matches, Orchard signs out their SSO sessions and deletes their API tokens for this organization.
- Orchard removes a membership only when a rule added or last changed it. People you invited or added by hand keep their access after a denied sign-in, but they cannot use this connection.
- If your provider sends too many groups (over 500, or more than 16 KB of names) or tells Orchard the list was cut short (Microsoft Entra ID group overage), Orchard treats the groups as unknown, denies the sign-in, and changes nothing.
- Editing or removing rules, or changing the group claim, signs out everyone the rules added.
- An organization can have group rules on one connection at a time.
- Groups are read only from the signed SAML assertion, or the validated OIDC ID token, of this organization's connection.

Orchard records `sso.rules.updated`, `sso.member.provisioned`, `sso.member.role_synced`, `sso.member.removed`, and `sso.login.denied` entries in the [audit log](/teams/audit-logs/), with the connection and rule IDs.

:::caution
A wrong `groupClaim` denies everyone except owners. Preview your rules, and sign in with a test account before you save a change to a connection that people rely on.
:::

If you also use [SCIM](/teams/scim/) roles, group rules win at the next sign-in.

### Sign-in identity

Orchard stores your provider's stable subject for each person on first sign-in. Later sign-ins match on that subject, not on the email address, so a changed or reassigned email in your provider does not move an identity to another account. If a different subject later arrives for an account that already has one, Orchard refuses the sign-in. For SAML, set the NameID format to persistent or an opaque ID. With an email NameID, the subject changes whenever the email does.

### Provider notes

| Provider                 | What to configure                                                                                                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Okta                     | OIDC: add a **Groups claim** with a filter such as `Matches regex .*` limited to the groups you map, on the ID token. SAML: add a **Group Attribute Statement** named `groups`.                     |
| Microsoft Entra ID       | Set the token's **groups** claim to **Groups assigned to the application**. Entra sends object IDs, so use the IDs as rule names. Over 150 groups in SAML, or 200 in a token, Entra omits the list. |
| Google Workspace         | Use SAML and map the **Group membership** attribute to the app attribute `groups`. Google does not send a groups claim with OIDC.                                                                   |
| Keycloak                 | Add a **Group Membership** mapper to the client with **Full group path** off. For SAML add a **Group list** attribute mapper named `groups`.                                                        |
| LDAP or Active Directory | Put [Dex or Keycloak in front](/operate/identity-bridge/) and treat it as an OIDC or SAML provider.                                                                                                 |

## Troubleshoot sign-in

| Message or symptom                                  | Cause and fix                                                                                                                                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sso_link_required`                                 | The account exists but is not linked. Verify the email domain, or have the person sign in to Orchard first and start from there.                                                       |
| Email not verified, or domain not allowed           | The provider did not assert `email_verified`, or the address is outside **Email domains**.                                                                                             |
| "None of your groups give access"                   | Group rules exist and none matched. Check the `groupClaim` name and the exact group names. The `sso.login.denied` audit entry says whether no rule matched or the groups were unknown. |
| SAML fails after a certificate rotation, or by time | Paste the new signing certificate into the connection. Keep provider and server clocks within one minute.                                                                              |
| Group rules lock people out                         | Owners are exempt from group rules. An owner who signs in through the connection they created can replace the rules.                                                                   |

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
