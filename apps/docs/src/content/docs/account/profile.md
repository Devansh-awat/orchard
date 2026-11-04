---
title: Update your profile
description: Change your Orchard name, username, profile photo and accessibility preferences.
sidebar:
  order: 1
---

To change how you appear in Orchard, update your profile. Your profile belongs to your account, so the same profile appears in every organization you belong to.

## Change your name or username

1. From the account menu, select **Account settings**.
2. In the header, select **Edit**.
3. Update **First name**, **Last name** or **Username**.
4. Select **Save**.

Orchard uses your username in URLs and mentions.

You can also run `orchard user profile update`. For the available flags, refer to the [CLI reference](/reference/cli/).

## Change your profile photo

1. From the account menu, select **Account settings**.
2. In the header, select your photo.
3. Choose an image file.

To remove the photo, use the remove control on the photo. Orchard does not import another picture after you remove one. To manage your photo from a terminal, use `orchard user avatar set` and `orchard user avatar delete`.

Orchard generates a mascot for every account. The mascot appears until you have a photo.

If your email address has a picture on Libravatar or Gravatar, Orchard imports a copy. Orchard fetches the picture from its server, so these services do not receive requests from your browser. A photo that you upload is not replaced by an imported picture.

## Set accessibility preferences

1. From the account menu, select **Account settings** > **Accessibility**.
2. Change any of the following settings.

| Setting                 | Options                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------ |
| **Animation**           | **System** follows your system setting. Other options are **Full**, **Reduced** and **Off**. |
| **Sound**               | Plays a cue when a build you are waiting on finishes.                                      |
| **Text size**           | **Small**, **Default**, **Large** or **Largest**.                                          |
| **Increase contrast**   | Uses darker text and visible borders.                                                      |
| **Reduce transparency** | Uses solid panels instead of glass and blur.                                               |

## Related resources

- [Sign-in and sessions](/account/security/)
- [Manage API tokens](/account/tokens/)
