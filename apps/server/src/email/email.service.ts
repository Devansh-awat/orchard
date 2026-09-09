import { InstanceConfigService } from '../instance-config/instance-config.service';
import { EMAIL } from '../instance-config/instance-config.sections';
import { Injectable } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';
import mjml2html from 'mjml';
import * as fs from 'fs';
import * as path from 'path';

export interface OrganizationInviteEmailData {
  recipientEmail: string;
  recipientName: string;
  organizationName: string;
  inviterName: string;
  role: string;
  loginUrl: string;
}

export interface ProjectInviteEmailData {
  recipientEmail: string;
  recipientName: string;
  organizationName: string;
  projectName: string;
  inviterName: string;
  role: string;
  loginUrl: string;
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

export interface NotificationEmailData {
  recipients: string[];
  subject: string;
  title: string;
  body: string;
  contextLine: string;
  ctaUrl: string;
}

@Injectable()
export class EmailService {
  private mailer: Transporter | null = null;

  private syncedAt = -1;

  private readonly frontendUrl: string;

  private readonly templatesDir: string;

  constructor(private readonly config: InstanceConfigService) {
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    this.templatesDir = path.join(__dirname, 'templates');
  }

  /**
   * The transport is rebuilt whenever instance config changes, so saving SMTP
   * settings in the admin UI takes effect without a restart. Built lazily
   * rather than in the constructor for the same reason: at construction time
   * the stored config has not been read yet.
   */
  private sync(): void {
    const generation = this.config.generation;
    if (this.syncedAt === generation) return;
    this.syncedAt = generation;

    const host = this.config.value(EMAIL, 'host');
    if (!host) {
      this.mailer = null;
      return;
    }
    this.mailer = nodemailer.createTransport({
      host,
      port: parseInt(this.config.value(EMAIL, 'port') || '587', 10),
      secure: this.config.value(EMAIL, 'secure') === 'true',
      auth: {
        user: this.config.value(EMAIL, 'user') ?? undefined,
        pass: this.config.value(EMAIL, 'pass') ?? undefined,
      },
    });
  }

  private get transporter(): Transporter | null {
    this.sync();
    return this.mailer;
  }

  private get fromEmail(): string {
    return this.config.value(EMAIL, 'from') || 'noreply@example.com';
  }

  private get fromName(): string {
    return this.config.value(EMAIL, 'fromName') || 'Orchard';
  }

  isConfigured(): boolean {
    return this.transporter !== null;
  }

  private escapeHtml(value: string): string {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  private async renderTemplate(
    templateName: string,
    variables: Record<string, string>,
  ): Promise<string> {
    const templatePath = path.join(this.templatesDir, `${templateName}.mjml`);
    let mjmlContent = fs.readFileSync(templatePath, 'utf-8');

    const assetBaseUrl = (process.env.EMAIL_ASSET_BASE_URL || 'https://orchard.my').replace(/\/$/, '');
    mjmlContent = mjmlContent.replaceAll('{{assetBaseUrl}}', assetBaseUrl);

    for (const [key, value] of Object.entries(variables)) {
      mjmlContent = mjmlContent.replaceAll(`{{${key}}}`, this.escapeHtml(value));
    }

    const { html, errors } = await mjml2html(mjmlContent);
    if (errors.length > 0) {
      console.warn(`MJML warnings for ${templateName}:`, errors);
    }
    return html;
  }

  async sendNotificationEmail(data: NotificationEmailData): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn('Email service not configured. Skipping notification email.');
      return false;
    }

    const html = await this.renderTemplate('notification', {
      title: data.title,
      body: data.body,
      contextLine: data.contextLine,
      ctaUrl: data.ctaUrl,
      frontendUrl: this.frontendUrl,
    });

    const mailOptions = {
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: data.recipients.join(', '),
      subject: data.subject,
      html,
    };

    try {
      await this.transporter!.sendMail(mailOptions);
      return true;
    } catch (error) {
      console.error('[EmailService] Failed to send notification email:', error);
      return false;
    }
  }

  async sendOrganizationInviteEmail(
    data: OrganizationInviteEmailData,
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn(
        'Email service not configured. Skipping organization invite email.',
      );
      return false;
    }

    const html = await this.renderTemplate('organization-invite', {
      recipientEmail: data.recipientEmail,
      recipientName: data.recipientName,
      organizationName: data.organizationName,
      inviterName: data.inviterName,
      role: data.role.charAt(0).toUpperCase() + data.role.slice(1),
      loginUrl: data.loginUrl,
      frontendUrl: this.frontendUrl,
    });

    const mailOptions = {
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: data.recipientEmail,
      subject: `You've been invited to join ${data.organizationName} on Orchard`,
      html,
    };
    console.log(`[EmailService] Sending organization invite email to=${data.recipientEmail} from=${mailOptions.from} subject="${mailOptions.subject}"`);

    try {
      const info = await this.transporter!.sendMail(mailOptions);
      console.log(`[EmailService] Organization invite email sent successfully messageId=${info.messageId} response="${info.response}"`);
      return true;
    } catch (error) {
      console.error('[EmailService] Failed to send organization invite email:', error);
      return false;
    }
  }

  async sendProjectInviteEmail(
    data: ProjectInviteEmailData,
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn(
        'Email service not configured. Skipping project invite email.',
      );
      return false;
    }

    const html = await this.renderTemplate('project-invite', {
      recipientEmail: data.recipientEmail,
      recipientName: data.recipientName,
      organizationName: data.organizationName,
      projectName: data.projectName,
      inviterName: data.inviterName,
      role: data.role.charAt(0).toUpperCase() + data.role.slice(1),
      loginUrl: data.loginUrl,
      frontendUrl: this.frontendUrl,
    });

    const mailOptions = {
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: data.recipientEmail,
      subject: `You've been invited to ${data.projectName} on Orchard`,
      html,
    };
    console.log(`[EmailService] Sending project invite email to=${data.recipientEmail} from=${mailOptions.from} subject="${mailOptions.subject}"`);

    try {
      const info = await this.transporter!.sendMail(mailOptions);
      console.log(`[EmailService] Project invite email sent successfully messageId=${info.messageId} response="${info.response}"`);
      return true;
    } catch (error) {
      console.error('[EmailService] Failed to send project invite email:', error);
      return false;
    }
  }

  async sendWorkspaceInviteEmail(
    data: WorkspaceInviteEmailData,
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn(
        'Email service not configured. Skipping workspace invite email.',
      );
      return false;
    }

    const html = await this.renderTemplate('workspace-invite', {
      recipientEmail: data.recipientEmail,
      recipientName: data.recipientName,
      workspaceName: data.workspaceName,
      organizationName: data.organizationName,
      inviterName: data.inviterName,
      role: data.role.charAt(0).toUpperCase() + data.role.slice(1),
      inviteUrl: data.inviteUrl,
      frontendUrl: this.frontendUrl,
    });

    const mailOptions = {
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: data.recipientEmail,
      subject: `You've been invited to ${data.workspaceName}`,
      html,
    };
    console.log(`[EmailService] Sending workspace invite email to=${data.recipientEmail} from=${mailOptions.from} subject="${mailOptions.subject}"`);

    try {
      const info = await this.transporter!.sendMail(mailOptions);
      console.log(`[EmailService] Workspace invite email sent successfully messageId=${info.messageId} response="${info.response}"`);
      return true;
    } catch (error) {
      console.error('[EmailService] Failed to send workspace invite email:', error);
      return false;
    }
  }

  async sendOtpEmail(data: OtpEmailData): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn('Email service not configured. Skipping OTP email.');
      console.log(`[DEV] OTP code for ${data.recipientEmail}: ${data.otpCode}`);
      return false;
    }

    const html = await this.renderTemplate('otp', {
      recipientEmail: data.recipientEmail,
      otpCode: data.otpCode,
      expiryMinutes: String(data.expiryMinutes),
      frontendUrl: this.frontendUrl,
    });

    const mailOptions = {
      from: `"${this.fromName}" <${this.fromEmail}>`,
      to: data.recipientEmail,
      subject: `Your Orchard verification code: ${data.otpCode}`,
      html,
    };
    console.log(`[EmailService] Sending OTP email to=${data.recipientEmail} from=${mailOptions.from}`);

    try {
      const info = await this.transporter!.sendMail(mailOptions);
      console.log(`[EmailService] OTP email sent successfully messageId=${info.messageId} response="${info.response}"`);
      return true;
    } catch (error) {
      console.error('[EmailService] Failed to send OTP email:', error);
      return false;
    }
  }
}
