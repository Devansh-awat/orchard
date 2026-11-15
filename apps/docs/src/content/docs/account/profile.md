---
title: Update your profile
description: Change your Orchard name, username, and profile photo.
sidebar:
  order: 1
---

Your profile is how other people see you in Orchard: your name, your username, and your photo. The profile belongs to your account instead of an organization, so a change here appears in every organization you belong to.

## Change your name or username

1. Go to **Account settings**.
2. In the header, select **Edit**.
3. Update **First name**, **Last name**, or **Username**.
4. Select **Save**.

Orchard uses your username in URLs and mentions.

You can also run `orchard user profile update`. The [CLI reference](/reference/cli/#user) lists its flags.

## Change your profile photo

1. Go to **Account settings**.
2. In the header, select your photo.
3. Select an image file.

To remove the photo, use the remove control on the photo. Orchard does not import another picture after you remove one. To manage your photo from a terminal, use `orchard user avatar set` and `orchard user avatar delete`.

Orchard generates a mascot for every account. The mascot appears until you have a photo.

If your email address has a picture on Libravatar or Gravatar, Orchard imports a copy. Orchard fetches the picture from its server, so these services do not receive requests from your browser. An imported picture does not replace a photo that you upload.

## Related resources

- [Set your preferences](/account/preferences/) - Change the theme, typeface, motion, and text size of the dashboard.
- [Manage sign-in and sessions](/account/security/) - Add passkeys and sign out devices that you no longer use.
