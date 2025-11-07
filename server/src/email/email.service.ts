import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

export interface OrganizationInviteEmailData {
  recipientEmail: string;
  recipientName: string;
  organizationName: string;
  inviterName: string;
  role: string;
  inviteUrl: string;
}

export interface WorkspaceInviteEmailData {
  recipientEmail: string;
  recipientName: string;
  workspaceName: string;
  organizationName: string;
  inviterName: string;
  role: string;
  inviteUrl: string;
}

export interface OtpEmailData {
  recipientEmail: string;
  otpCode: string;
  expiryMinutes: number;
}

@Injectable()
export class EmailService {
  private transporter: Transporter | null = null;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly frontendUrl: string;

  constructor() {
    this.fromEmail = process.env.SMTP_FROM_EMAIL || 'noreply@example.com';
    this.fromName = process.env.SMTP_FROM_NAME || 'Orchard';
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';

    if (process.env.SMTP_HOST) {
      this.transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: parseInt(process.env.SMTP_PORT || '587', 10),
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        },
      });
    }
  }

  private isConfigured(): boolean {
    return this.transporter !== null;
  }

  async sendOrganizationInviteEmail(data: OrganizationInviteEmailData): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn('Email service not configured. Skipping organization invite email.');
      return false;
    }

    const html = this.generateOrganizationInviteHtml(data);

    try {
      await this.transporter!.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: data.recipientEmail,
        subject: `You've been invited to join ${data.organizationName} on Orchard`,
        html,
      });
      return true;
    } catch (error) {
      console.error('Failed to send organization invite email:', error);
      return false;
    }
  }

  async sendWorkspaceInviteEmail(data: WorkspaceInviteEmailData): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn('Email service not configured. Skipping workspace invite email.');
      return false;
    }

    const html = this.generateWorkspaceInviteHtml(data);

    try {
      await this.transporter!.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: data.recipientEmail,
        subject: `You've been invited to ${data.workspaceName}`,
        html,
      });
      return true;
    } catch (error) {
      console.error('Failed to send workspace invite email:', error);
      return false;
    }
  }

  async sendOtpEmail(data: OtpEmailData): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn('Email service not configured. Skipping OTP email.');
      console.log(`[DEV] OTP code for ${data.recipientEmail}: ${data.otpCode}`);
      return false;
    }

    const html = this.generateOtpHtml(data);

    try {
      await this.transporter!.sendMail({
        from: `"${this.fromName}" <${this.fromEmail}>`,
        to: data.recipientEmail,
        subject: `Your Orchard verification code: ${data.otpCode}`,
        html,
      });
      return true;
    } catch (error) {
      console.error('Failed to send OTP email:', error);
      return false;
    }
  }

  private generateOtpHtml(data: OtpEmailData): string {
    return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">

<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <!--[if !mso]><!-- -->
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <!--<![endif]-->
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
  <meta name="x-apple-disable-message-reformatting" />
  <link href="https://fonts.googleapis.com/css?family=Inter:ital,wght@0,400;0,600;0,700" rel="stylesheet" />
  <title>Your Verification Code</title>
  <style>
    html, body { margin: 0 !important; padding: 0 !important; min-height: 100% !important; width: 100% !important; -webkit-font-smoothing: antialiased; }
    * { -ms-text-size-adjust: 100%; }
    #outlook a { padding: 0; }
    .ReadMsgBody, .ExternalClass { width: 100%; }
    .ExternalClass, .ExternalClass p, .ExternalClass td, .ExternalClass div, .ExternalClass span, .ExternalClass font { line-height: 100%; }
    table, td, th { mso-table-lspace: 0 !important; mso-table-rspace: 0 !important; border-collapse: collapse; }
    body, td, th, p, div, li, a, span { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; mso-line-height-rule: exactly; }
    img { border: 0; outline: 0; line-height: 100%; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
    .otp-code { font-family: 'Courier New', monospace; font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #14532d; background-color: #d1fae5; padding: 16px 24px; border-radius: 8px; display: inline-block; }
    @media (max-width: 620px) {
      .pc-project-body { min-width: 0px !important; }
      .pc-project-container { width: 100% !important; }
      .pc-sm-padding { padding: 20px !important; }
      .pc-sm-font-size-32 { font-size: 32px !important; }
      .pc-sm-font-size-16 { font-size: 16px !important; }
      .otp-code { font-size: 28px !important; letter-spacing: 6px !important; }
    }
  </style>
</head>

<body style="width: 100% !important; min-height: 100% !important; margin: 0 !important; padding: 0 !important; background-color: #22c55e;" bgcolor="#22c55e">
  <table class="pc-project-body" style="table-layout: fixed; width: 100%; min-width: 600px; background-color: #22c55e;" bgcolor="#22c55e" border="0" cellspacing="0" cellpadding="0" role="presentation">
    <tr>
      <td align="center" valign="top">
        <table class="pc-project-container" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 600px; max-width: 600px;">
          <tr>
            <td style="padding: 20px 0px 20px 0px;" align="left" valign="top">

              <!-- Header with Logo -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 38px 40px 28px 40px; background-color: #f0fdf4; border-radius: 8px 8px 0 0;" bgcolor="#f0fdf4">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" valign="top">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 28px; font-weight: 700; color: #22c55e; letter-spacing: -1px;">
                            Orchard
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Main Content -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 32px 40px 40px 40px; background-color: #f0fdf4;" bgcolor="#f0fdf4">

                    <!-- Title -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 0px 16px 0px;">
                          <div class="pc-sm-font-size-32" style="font-family: 'Inter', Arial, sans-serif; font-size: 36px; font-weight: 400; color: #1f2937; letter-spacing: -2px; line-height: 110%;">
                            Your Verification Code
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Subtitle -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 32px 32px 32px;">
                          <div class="pc-sm-font-size-16" style="font-family: 'Inter', Arial, sans-serif; font-size: 18px; color: #4b5563; line-height: 140%;">
                            Enter this code to sign in to your Orchard account.
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- OTP Code Display -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 0px 32px 0px;">
                          <div class="otp-code">${data.otpCode}</div>
                        </td>
                      </tr>
                    </table>

                    <!-- Expiry Notice -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 0px 24px 0px;">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 14px; color: #6b7280; line-height: 140%;">
                            This code expires in <strong>${data.expiryMinutes} minutes</strong>.
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Security Notice -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 16px; background-color: #fef3c7; border-radius: 8px;">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 14px; color: #92400e; line-height: 140%;">
                            <strong>Security tip:</strong> Never share this code with anyone. Orchard will never ask you for this code via phone, text, or another email.
                          </div>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

              <!-- Footer -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 32px 40px; background-color: #ffffff; border-radius: 0 0 8px 8px;" bgcolor="#ffffff">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 14px; color: #6b7280; line-height: 140%;">
                            This email was sent to ${data.recipientEmail}. If you didn't request this code, you can safely ignore this email.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private generateOrganizationInviteHtml(data: OrganizationInviteEmailData): string {
    return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">

<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <!--[if !mso]><!-- -->
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <!--<![endif]-->
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
  <meta name="x-apple-disable-message-reformatting" />
  <link href="https://fonts.googleapis.com/css?family=Inter:ital,wght@0,400;0,600;0,700" rel="stylesheet" />
  <title>Organization Invitation</title>
  <style>
    html, body { margin: 0 !important; padding: 0 !important; min-height: 100% !important; width: 100% !important; -webkit-font-smoothing: antialiased; }
    * { -ms-text-size-adjust: 100%; }
    #outlook a { padding: 0; }
    .ReadMsgBody, .ExternalClass { width: 100%; }
    .ExternalClass, .ExternalClass p, .ExternalClass td, .ExternalClass div, .ExternalClass span, .ExternalClass font { line-height: 100%; }
    table, td, th { mso-table-lspace: 0 !important; mso-table-rspace: 0 !important; border-collapse: collapse; }
    body, td, th, p, div, li, a, span { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; mso-line-height-rule: exactly; }
    img { border: 0; outline: 0; line-height: 100%; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
    @media (max-width: 620px) {
      .pc-project-body { min-width: 0px !important; }
      .pc-project-container { width: 100% !important; }
      .pc-sm-padding { padding: 20px !important; }
      .pc-sm-font-size-32 { font-size: 32px !important; }
      .pc-sm-font-size-16 { font-size: 16px !important; }
    }
  </style>
</head>

<body style="width: 100% !important; min-height: 100% !important; margin: 0 !important; padding: 0 !important; background-color: #22c55e;" bgcolor="#22c55e">
  <table class="pc-project-body" style="table-layout: fixed; width: 100%; min-width: 600px; background-color: #22c55e;" bgcolor="#22c55e" border="0" cellspacing="0" cellpadding="0" role="presentation">
    <tr>
      <td align="center" valign="top">
        <table class="pc-project-container" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 600px; max-width: 600px;">
          <tr>
            <td style="padding: 20px 0px 20px 0px;" align="left" valign="top">

              <!-- Header with Logo -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 38px 40px 28px 40px; background-color: #f0fdf4; border-radius: 8px 8px 0 0;" bgcolor="#f0fdf4">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" valign="top">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 28px; font-weight: 700; color: #22c55e; letter-spacing: -1px;">
                            Orchard
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Main Content -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 32px 40px 40px 40px; background-color: #f0fdf4;" bgcolor="#f0fdf4">

                    <!-- Title -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 0px 16px 0px;">
                          <div class="pc-sm-font-size-32" style="font-family: 'Inter', Arial, sans-serif; font-size: 42px; font-weight: 400; color: #1f2937; letter-spacing: -2px; line-height: 110%;">
                            You're Invited!
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Subtitle -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 32px 32px 32px;">
                          <div class="pc-sm-font-size-16" style="font-family: 'Inter', Arial, sans-serif; font-size: 18px; color: #4b5563; line-height: 140%;">
                            ${data.inviterName} has invited you to join <strong>${data.organizationName}</strong> on Orchard.
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Info Card -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 32px 0px;">
                          <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
                            <tr>
                              <td style="padding: 24px; border-radius: 10px; background-color: #14532d;">

                                <!-- Card Title -->
                                <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                                  <tr>
                                    <td style="padding: 0px 0px 8px 0px;">
                                      <div style="font-family: 'Inter', Arial, sans-serif; font-size: 24px; font-weight: 400; color: #ffffff;">
                                        Join ${data.organizationName}
                                      </div>
                                    </td>
                                  </tr>
                                </table>

                                <!-- Card Description -->
                                <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                                  <tr>
                                    <td style="padding: 0px 0px 16px 0px;">
                                      <div style="font-family: 'Inter', Arial, sans-serif; font-size: 15px; color: #a7f3d0; line-height: 140%;">
                                        Click the button below to accept this invitation. If you don't have an account yet, you'll be able to create one.
                                      </div>
                                    </td>
                                  </tr>
                                </table>

                                <!-- CTA Button -->
                                <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                                  <tr>
                                    <td>
                                      <a style="display: inline-block; border-radius: 6px; background-color: #22c55e; padding: 14px 28px; font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;" href="${data.inviteUrl}">
                                        Accept Invitation
                                      </a>
                                    </td>
                                  </tr>
                                </table>

                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Details Row: Organization -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                              <td style="width: 50%;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; color: #6b7280;">
                                  Organization
                                </div>
                              </td>
                              <td style="width: 50%; text-align: right;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #1f2937;">
                                  ${data.organizationName}
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Divider -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <div style="border-bottom: 1px solid #d1d5db;"></div>
                        </td>
                      </tr>
                    </table>

                    <!-- Details Row: Role -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                              <td style="width: 50%;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; color: #6b7280;">
                                  Your Role
                                </div>
                              </td>
                              <td style="width: 50%; text-align: right;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #1f2937;">
                                  ${data.role.charAt(0).toUpperCase() + data.role.slice(1)}
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Divider -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <div style="border-bottom: 1px solid #d1d5db;"></div>
                        </td>
                      </tr>
                    </table>

                    <!-- Details Row: Added By -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td>
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                              <td style="width: 50%;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; color: #6b7280;">
                                  Invited By
                                </div>
                              </td>
                              <td style="width: 50%; text-align: right;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #1f2937;">
                                  ${data.inviterName}
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

              <!-- Footer -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 32px 40px; background-color: #ffffff; border-radius: 0 0 8px 8px;" bgcolor="#ffffff">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 14px; color: #6b7280; line-height: 140%;">
                            This email was sent to ${data.recipientEmail} because you were invited to join an organization on Orchard. This invitation expires in 7 days.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private generateWorkspaceInviteHtml(data: WorkspaceInviteEmailData): string {
    return `<!DOCTYPE html>
<html xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">

<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Type" content="text/html; charset=utf-8" />
  <!--[if !mso]><!-- -->
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <!--<![endif]-->
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="format-detection" content="telephone=no, date=no, address=no, email=no" />
  <meta name="x-apple-disable-message-reformatting" />
  <link href="https://fonts.googleapis.com/css?family=Inter:ital,wght@0,400;0,600;0,700" rel="stylesheet" />
  <title>Workspace Invitation</title>
  <style>
    html, body { margin: 0 !important; padding: 0 !important; min-height: 100% !important; width: 100% !important; -webkit-font-smoothing: antialiased; }
    * { -ms-text-size-adjust: 100%; }
    #outlook a { padding: 0; }
    .ReadMsgBody, .ExternalClass { width: 100%; }
    .ExternalClass, .ExternalClass p, .ExternalClass td, .ExternalClass div, .ExternalClass span, .ExternalClass font { line-height: 100%; }
    table, td, th { mso-table-lspace: 0 !important; mso-table-rspace: 0 !important; border-collapse: collapse; }
    body, td, th, p, div, li, a, span { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; mso-line-height-rule: exactly; }
    img { border: 0; outline: 0; line-height: 100%; text-decoration: none; -ms-interpolation-mode: bicubic; }
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
    @media (max-width: 620px) {
      .pc-project-body { min-width: 0px !important; }
      .pc-project-container { width: 100% !important; }
      .pc-sm-padding { padding: 20px !important; }
      .pc-sm-font-size-32 { font-size: 32px !important; }
      .pc-sm-font-size-16 { font-size: 16px !important; }
    }
  </style>
</head>

<body style="width: 100% !important; min-height: 100% !important; margin: 0 !important; padding: 0 !important; background-color: #22c55e;" bgcolor="#22c55e">
  <table class="pc-project-body" style="table-layout: fixed; width: 100%; min-width: 600px; background-color: #22c55e;" bgcolor="#22c55e" border="0" cellspacing="0" cellpadding="0" role="presentation">
    <tr>
      <td align="center" valign="top">
        <table class="pc-project-container" align="center" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width: 600px; max-width: 600px;">
          <tr>
            <td style="padding: 20px 0px 20px 0px;" align="left" valign="top">

              <!-- Header with Logo -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 38px 40px 28px 40px; background-color: #f0fdf4; border-radius: 8px 8px 0 0;" bgcolor="#f0fdf4">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" valign="top">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 28px; font-weight: 700; color: #22c55e; letter-spacing: -1px;">
                            Orchard
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

              <!-- Main Content -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 32px 40px 40px 40px; background-color: #f0fdf4;" bgcolor="#f0fdf4">

                    <!-- Title -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 0px 16px 0px;">
                          <div class="pc-sm-font-size-32" style="font-family: 'Inter', Arial, sans-serif; font-size: 42px; font-weight: 400; color: #1f2937; letter-spacing: -2px; line-height: 110%;">
                            Workspace Invitation
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Subtitle -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center" style="padding: 0px 32px 32px 32px;">
                          <div class="pc-sm-font-size-16" style="font-family: 'Inter', Arial, sans-serif; font-size: 18px; color: #4b5563; line-height: 140%;">
                            ${data.inviterName} has invited you to join the workspace <strong>${data.workspaceName}</strong>.
                          </div>
                        </td>
                      </tr>
                    </table>

                    <!-- Info Card -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 32px 0px;">
                          <table border="0" cellpadding="0" cellspacing="0" role="presentation" width="100%">
                            <tr>
                              <td style="padding: 24px; border-radius: 10px; background-color: #14532d;">

                                <!-- Card Title -->
                                <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                                  <tr>
                                    <td style="padding: 0px 0px 8px 0px;">
                                      <div style="font-family: 'Inter', Arial, sans-serif; font-size: 24px; font-weight: 400; color: #ffffff;">
                                        Join ${data.workspaceName}
                                      </div>
                                    </td>
                                  </tr>
                                </table>

                                <!-- Card Description -->
                                <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                                  <tr>
                                    <td style="padding: 0px 0px 16px 0px;">
                                      <div style="font-family: 'Inter', Arial, sans-serif; font-size: 15px; color: #a7f3d0; line-height: 140%;">
                                        Accept this invitation to collaborate on projects and access workspace resources.
                                      </div>
                                    </td>
                                  </tr>
                                </table>

                                <!-- CTA Button -->
                                <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                                  <tr>
                                    <td>
                                      <a style="display: inline-block; border-radius: 6px; background-color: #22c55e; padding: 14px 28px; font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #ffffff; text-decoration: none;" href="${data.inviteUrl}">
                                        Accept Invitation
                                      </a>
                                    </td>
                                  </tr>
                                </table>

                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Details Row: Workspace -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                              <td style="width: 50%;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; color: #6b7280;">
                                  Workspace
                                </div>
                              </td>
                              <td style="width: 50%; text-align: right;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #1f2937;">
                                  ${data.workspaceName}
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Divider -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <div style="border-bottom: 1px solid #d1d5db;"></div>
                        </td>
                      </tr>
                    </table>

                    <!-- Details Row: Organization -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                              <td style="width: 50%;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; color: #6b7280;">
                                  Organization
                                </div>
                              </td>
                              <td style="width: 50%; text-align: right;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #1f2937;">
                                  ${data.organizationName}
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Divider -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <div style="border-bottom: 1px solid #d1d5db;"></div>
                        </td>
                      </tr>
                    </table>

                    <!-- Details Row: Role -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                              <td style="width: 50%;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; color: #6b7280;">
                                  Your Role
                                </div>
                              </td>
                              <td style="width: 50%; text-align: right;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #1f2937;">
                                  ${data.role.charAt(0).toUpperCase() + data.role.slice(1)}
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                    <!-- Divider -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td style="padding: 0px 0px 16px 0px;">
                          <div style="border-bottom: 1px solid #d1d5db;"></div>
                        </td>
                      </tr>
                    </table>

                    <!-- Details Row: Invited By -->
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td>
                          <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                            <tr>
                              <td style="width: 50%;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; color: #6b7280;">
                                  Invited By
                                </div>
                              </td>
                              <td style="width: 50%; text-align: right;">
                                <div style="font-family: 'Inter', Arial, sans-serif; font-size: 16px; font-weight: 600; color: #1f2937;">
                                  ${data.inviterName}
                                </div>
                              </td>
                            </tr>
                          </table>
                        </td>
                      </tr>
                    </table>

                  </td>
                </tr>
              </table>

              <!-- Footer -->
              <table style="width: 100%;" border="0" cellspacing="0" cellpadding="0" role="presentation">
                <tr>
                  <td class="pc-sm-padding" style="padding: 32px 40px; background-color: #ffffff; border-radius: 0 0 8px 8px;" bgcolor="#ffffff">
                    <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td align="center">
                          <div style="font-family: 'Inter', Arial, sans-serif; font-size: 14px; color: #6b7280; line-height: 140%;">
                            This email was sent to ${data.recipientEmail} because you were invited to a workspace on Orchard.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>

            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}
