---
title: Sign-in and sessions
description: Email codes, passkeys, and controlling where you are signed in.
sidebar:
  order: 2
---

## Ways to sign in

**Email code.** Request a one-time code, receive it by email, enter it. No
password to leak or reuse.

**Passkeys.** Register a passkey and sign in with Touch ID, Windows Hello, a
phone or a hardware key. Passkeys are phishing-resistant, because the credential
is bound to the site that issued it.

You can register more than one, and rename them so "MacBook" and "YubiKey" are
distinguishable when you come to remove one. Keep at least two if a passkey is
your only method, or you are one lost laptop from being locked out.

**SSO.** If your organization has it configured, you sign in through your
identity provider instead. See [SSO](/teams/sso/).

## Sessions

Every sign-in creates a session. The sessions list shows what is currently
signed in, and lets you revoke any of them individually, or **revoke all at
once**.

Revoke all is the right move if a device is lost or you suspect something is
wrong. It ends every session, including the one you are using, so you sign in
again afterwards.

Sessions expire on their own, which is why a browser you have not used for a
while asks for a code again.

## Agent connections

An MCP connection is backed by a session for your account, so revoking sessions
revokes agent access too. There is no separate list of agent grants to forget
about. See [MCP](/mcp/).
