---
title: Map groups and bridge LDAP
description: Route people from an instance identity provider into organizations by group, and sign in from LDAP or Active Directory through Dex or Keycloak.
sidebar:
  order: 6
---

An instance identity provider can put people into organizations and give them roles based on the groups your provider sends, so access follows your directory instead of a list that someone keeps by hand. When someone joins or leaves a group, their Orchard access changes at their next sign-in.

Orchard has no built-in LDAP client. To use LDAP or Active Directory, put Dex or Keycloak in front of the directory and add the bridge as an OpenID Connect (OIDC) or SAML provider.

## Prerequisites

- The superadmin role.
- An OIDC or SAML provider added at **Instance admin** > **Sign in**. Refer to [Set up SSO](/teams/sso/).
- One or more organizations to map people into.

## Map groups to organizations

An instance rule is an exact group name, a target organization, and a role. Rules belong to one provider. You can edit them in **Instance admin** > **Sign in** > **Group rules**, or through the API as in the following steps.

1. Make the provider send group names, and add `groups` to the provider's scopes if it is an OIDC provider that needs the scope.
2. Preview group names against the saved rules:

   ```sh
   curl -X POST "$ORCHARD/apiv1/admin/sso/providers/$PROVIDER/rules/preview" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"groups":["eng"]}'
   ```

3. Replace the provider's rules. Each rule names the organization it grants into:

   ```sh
   curl -X PUT "$ORCHARD/apiv1/admin/sso/providers/$PROVIDER/rules" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"groupClaim":"groups","rules":[{"value":"eng","role":"member","organizationId":"<org id>"},{"value":"eng-leads","role":"admin","organizationId":"<org id>"}]}'
   ```

How rules behave:

- Roles are `admin`, `member`, and `guest`. A rule can never give `owner`. To make the people in a group superadmins, use the separate **Superadmin group** setting instead. Refer to [Route instance sign-ins into organizations](/teams/sso/#route-instance-sign-ins-into-organizations).
- Group names match exactly after Unicode normalization, and case matters. Refer to [Map provider groups to roles](/teams/sso/#map-provider-groups-to-roles) for every matching rule.
- Once a provider has any rule, a person who matches none is denied, and no account is created. Superadmins are exempt and are never changed by rules.
- A matching group counts as access when sign-ups are closed or invite-only, because you wrote the rule.
- At each sign-in Orchard adds the person to every target organization they match and sets the role. It removes memberships a rule added once the person no longer matches, and signs out the SSO sessions and deletes the API tokens for the organization when a role drops or a membership is removed.
- Memberships that someone created another way are re-roled when the person matches, and are never removed by a rule.
- Only one provider can hold rules for a given organization.
- Every change is in the audit log: `sso.rules.updated`, `sso.member.provisioned`, `sso.member.role_synced`, `sso.member.removed`, and `sso.login.denied`.

Roll out rules in this order: add the rules, preview with real group names, sign in with a test account, then tell everyone else.

Group rules map into organizations that already exist. To have a group create its own organization at first sign-in, turn on **Let providers create organizations**. Refer to [Route instance sign-ins into organizations](/teams/sso/#route-instance-sign-ins-into-organizations).

## Bridge LDAP or Active Directory

Dex is a small OIDC provider that signs people in against LDAP. Run it where Orchard can reach it, with your directory behind it.

1. Deploy Dex with an LDAP connector and a static client for Orchard. This is a minimal configuration:

   ```yaml
   issuer: https://dex.example.com
   connectors:
     - type: ldap
       id: ldap
       name: Directory
       config:
         host: ldap.example.com:636
         bindDN: cn=svc-dex,ou=service,dc=example,dc=com
         bindPW: $LDAP_BIND_PASSWORD
         userSearch:
           baseDN: ou=people,dc=example,dc=com
           filter: '(objectClass=person)'
           username: uid
           idAttr: uid
           emailAttr: mail
           nameAttr: cn
         groupSearch:
           baseDN: ou=groups,dc=example,dc=com
           filter: '(objectClass=groupOfNames)'
           userMatchers:
             - userAttr: DN
               groupAttr: member
           nameAttr: cn
   staticClients:
     - id: orchard
       name: Orchard
       secret: $ORCHARD_CLIENT_SECRET
       redirectURIs:
         - https://<your Orchard host>/apiv1/sso/callback/<provider id>
   ```

2. Add an OIDC provider in Orchard with Dex's issuer URL, the client ID and secret, and the scopes `openid email profile groups`.
3. Save the provider, copy its **Redirect URL** into the Dex client, and test the connection.
4. Add group rules for the directory groups you want to map.

Dex emits group names in the `groups` claim. Use LDAPS or StartTLS between Dex and the directory, and a read-only service account.

If Dex runs inside the cluster, Orchard's request guard blocks the private address. Set `SSO_ALLOW_INTERNAL_IDP=true` on the server to allow it for instance identity providers. Organization providers can never reach internal addresses, so each tenant's identity provider has to be on the public internet. To set a server variable, refer to [Configuration](/operate/configuration/).

Keycloak works the same way. Add an LDAP user federation provider and a group mapper in Keycloak, then add Keycloak to Orchard as an OIDC or SAML provider.

## Start sign-in from the provider

Orchard rejects responses that a SAML provider starts on its own. Point the provider's app tile at `https://<your Orchard host>/apiv1/sso/start/<provider id>` instead. Refer to [Start sign-in from your provider's app tile](/teams/sso/#start-sign-in-from-your-providers-app-tile).

## Related resources

- [Set up SSO](/teams/sso/) - Add an identity provider and require single sign-on.
- [Set up SCIM provisioning](/teams/scim/) - Create and turn off accounts from your company directory.
