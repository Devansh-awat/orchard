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
  private readonly templatesDir: string;

  constructor() {
    this.fromEmail = process.env.SMTP_FROM || 'noreply@example.com';
    this.fromName = process.env.SMTP_FROM_NAME || 'Orchard';
    this.frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    this.templatesDir = path.join(__dirname, 'templates');

    console.log(`[EmailService] Initializing with from="${this.fromName}" <${this.fromEmail}>`);
    console.log(`[EmailService] SMTP_HOST=${process.env.SMTP_HOST || '(not set)'}, SMTP_PORT=${process.env.SMTP_PORT || '(not set)'}, SMTP_USER=${process.env.SMTP_USER ? '***set***' : '(not set)'}, SMTP_PASS=${process.env.SMTP_PASS ? '***set***' : '(not set)'}`);

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
      console.log('[EmailService] SMTP transporter created successfully');
    } else {
      console.warn('[EmailService] SMTP_HOST not set — email sending is disabled');
    }
  }

  private isConfigured(): boolean {
    return this.transporter !== null;
  }

  private renderTemplate(
    templateName: string,
    variables: Record<string, string>,
  ): string {
    const templatePath = path.join(this.templatesDir, `${templateName}.mjml`);
    let mjmlContent = fs.readFileSync(templatePath, 'utf-8');

    for (const [key, value] of Object.entries(variables)) {
      mjmlContent = mjmlContent.replaceAll(`{{${key}}}`, value);
    }

    const { html, errors } = mjml2html(mjmlContent);
    if (errors.length > 0) {
      console.warn(`MJML warnings for ${templateName}:`, errors);
    }
    return html;
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

    const html = this.renderTemplate('organization-invite', {
      recipientEmail: data.recipientEmail,
      recipientName: data.recipientName,
      organizationName: data.organizationName,
      inviterName: data.inviterName,
      role: data.role.charAt(0).toUpperCase() + data.role.slice(1),
      inviteUrl: data.inviteUrl,
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

  async sendWorkspaceInviteEmail(
    data: WorkspaceInviteEmailData,
  ): Promise<boolean> {
    if (!this.isConfigured()) {
      console.warn(
        'Email service not configured. Skipping workspace invite email.',
      );
      return false;
    }

    const html = this.renderTemplate('workspace-invite', {
      recipientEmail: data.recipientEmail,
      recipientName: data.recipientName,
      workspaceName: data.workspaceName,
      organizationName: data.organizationName,
      inviterName: data.inviterName,
      role: data.role.charAt(0).toUpperCase() + data.role.slice(1),
      inviteUrl: data.inviteUrl,
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

    const html = this.renderTemplate('otp', {
      recipientEmail: data.recipientEmail,
      otpCode: data.otpCode,
      expiryMinutes: String(data.expiryMinutes),
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
