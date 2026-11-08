import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  VerifiedRegistrationResponse,
  VerifiedAuthenticationResponse,
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON
} from '@simplewebauthn/server';
import { normalizeBoundedEmail } from './email-normalize';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';
import { RateLimitService, CLEANUP_BATCH, CLEANUP_MAX_BATCHES } from './rate-limit.service';

const CHALLENGE_EXPIRY_MINUTES = 5;

// WebAuthn RP (Relying Party) configuration
// These should be configured via environment variables in production
const getRpConfig = () => {
  const origin = process.env.WEBAUTHN_ORIGIN || process.env.FRONTEND_URL || 'http://localhost:3000';

  let rpID = process.env.WEBAUTHN_RP_ID;
  if (!rpID) {
    try {
      const parsed = new URL(origin);
      rpID = parsed.hostname;
    } catch {
      rpID = 'localhost';
    }
  }

  return {
    rpName: process.env.WEBAUTHN_RP_NAME || 'Orchard',
    rpID,
    origin
  };
};

@Injectable()
export class PasskeyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rateLimitService: RateLimitService
  ) {}

  /**
   * Generate registration options for creating a new passkey.
   * The user must be authenticated (via OTP or existing session).
   */
  async generateRegistrationOptions(
    userId: string,
    email: string
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const { rpName, rpID } = getRpConfig();

    // Get user's existing passkeys to exclude from registration
    const existingPasskeys = await this.prisma.passkey.findMany({
      where: { userId },
      select: { credentialId: true, transports: true }
    });

    const excludeCredentials = existingPasskeys.map((passkey) => ({
      id: passkey.credentialId,
      transports: passkey.transports as AuthenticatorTransportFuture[]
    }));

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: email,
      userDisplayName: email,
      userID: new TextEncoder().encode(userId),
      attestationType: 'none', // We don't need attestation for passkeys
      excludeCredentials,
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      },
      timeout: 60000 // 1 minute
    });

    await this.storeChallenge(options.challenge, 'registration', email, userId);

    return options;
  }

  /**
   * Verify a registration response and store the passkey.
   */
  async verifyRegistration(
    userId: string,
    email: string,
    response: RegistrationResponseJSON,
    friendlyName?: string
  ): Promise<{ verified: boolean; passkeyId?: string }> {
    const { rpID, origin } = getRpConfig();

    const challengeRecord = await this.getAndValidateChallenge(
      response?.response?.clientDataJSON,
      'registration',
      email
    );

    if (!challengeRecord || challengeRecord.userId !== userId) {
      throw new BadRequestException('Invalid or expired registration challenge');
    }

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false // Be flexible for compatibility
      });
    } catch (error) {
      console.error('Passkey registration verification failed:', error);
      throw new BadRequestException('Passkey registration verification failed');
    }

    if (!verification.verified || !verification.registrationInfo) {
      throw new BadRequestException('Passkey registration verification failed');
    }

    const { credential, credentialDeviceType, credentialBackedUp, aaguid } =
      verification.registrationInfo;

    const existingPasskey = await this.prisma.passkey.findUnique({
      where: { credentialId: credential.id }
    });

    if (existingPasskey) {
      throw new BadRequestException('This passkey is already registered');
    }

    const passkey = await this.prisma.$transaction(async (tx) => {
      await this.consumeChallenge(tx, challengeRecord.id);
      return tx.passkey.create({
        data: {
          userId,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString('base64url'),
          counter: BigInt(credential.counter),
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
          transports: response.response.transports || [],
          aaguid,
          friendlyName: friendlyName || 'Passkey'
        }
      });
    });

    return { verified: true, passkeyId: passkey.id };
  }

  async generateAuthenticationOptions(
    email?: string,
    ipAddress?: string
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { rpID } = getRpConfig();

    if (email != null && typeof email !== 'string') {
      throw new BadRequestException('Invalid email');
    }
    const normalizedEmail = email ? normalizeBoundedEmail(email) : undefined;
    const { pressured } = await this.rateLimitService.checkRateLimits('passkey_auth', {
      ip: ipAddress || undefined,
      identities: normalizedEmail ? [[normalizedEmail, 'email']] : []
    });
    if (pressured) await this.rateLimitService.slowDown();

    let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];

    // If email is provided, only allow passkeys for that user
    if (normalizedEmail) {
      const user = await this.prisma.user.findUnique({
        where: { email: normalizedEmail },
        include: { passkeys: true }
      });

      if (user && user.passkeys.length > 0) {
        allowCredentials = user.passkeys.map((passkey) => ({
          id: passkey.credentialId,
          transports: passkey.transports as AuthenticatorTransportFuture[]
        }));
      }
    }

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: allowCredentials.length > 0 ? allowCredentials : undefined,
      userVerification: 'preferred',
      timeout: 60000 // 1 minute
    });

    await this.storeChallenge(options.challenge, 'authentication', normalizedEmail);

    return options;
  }

  /**
   * Verify an authentication response and return the authenticated user.
   */
  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    ipAddress: string
  ): Promise<{ verified: boolean; userId?: string; email?: string }> {
    const { rpID, origin } = getRpConfig();

    if (!response || typeof response.id !== 'string' || !response.id) {
      throw new BadRequestException('Invalid passkey response');
    }

    const passkey = await this.prisma.passkey.findUnique({
      where: { credentialId: response.id },
      include: { user: true }
    });

    if (!passkey) {
      throw new BadRequestException('Passkey not found');
    }

    await this.rateLimitService.checkRateLimit(passkey.user.email, 'email', 'passkey_auth');

    const challengeRecord = await this.getAndValidateChallenge(
      response.response?.clientDataJSON,
      'authentication'
    );

    if (!challengeRecord) {
      throw new BadRequestException('Invalid or expired authentication challenge');
    }

    if (challengeRecord.email && challengeRecord.email !== passkey.user.email.toLowerCase()) {
      throw new BadRequestException("This passkey doesn't belong to the requested account");
    }

    const userHandle = response.response.userHandle;
    if (
      userHandle != null &&
      (typeof userHandle !== 'string' ||
        !Buffer.from(userHandle, 'base64url').equals(Buffer.from(passkey.userId)))
    ) {
      throw new BadRequestException("This passkey doesn't belong to the requested account");
    }

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challengeRecord.challenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: Buffer.from(passkey.publicKey, 'base64url'),
          counter: Number(passkey.counter),
          transports: passkey.transports as AuthenticatorTransportFuture[]
        },
        requireUserVerification: false
      });
    } catch (error) {
      console.error('Passkey authentication verification failed:', error);
      throw new BadRequestException('Passkey authentication verification failed');
    }

    if (!verification.verified) {
      throw new BadRequestException('Passkey authentication failed');
    }

    const { newCounter, credentialDeviceType, credentialBackedUp } =
      verification.authenticationInfo;

    if (credentialDeviceType !== passkey.deviceType) {
      throw new BadRequestException('Passkey backup eligibility changed');
    }

    await this.prisma.$transaction(async (tx) => {
      await this.consumeChallenge(tx, challengeRecord.id);
      const updated = await tx.passkey.updateMany({
        where: { id: passkey.id, counter: passkey.counter },
        data: {
          counter: BigInt(newCounter),
          backedUp: credentialBackedUp,
          lastUsedAt: new Date()
        }
      });
      if (updated.count !== 1) {
        throw new BadRequestException('Passkey changed during sign-in. Try again.');
      }
    });

    await this.rateLimitService.resetRateLimit(passkey.user.email, 'email', 'passkey_auth');
    await this.rateLimitService.resetRateLimit(ipAddress, 'ip', 'passkey_auth');

    return {
      verified: true,
      userId: passkey.userId,
      email: passkey.user.email
    };
  }

  async getUserPasskeys(userId: string) {
    return this.prisma.passkey.findMany({
      where: { userId },
      select: {
        id: true,
        friendlyName: true,
        deviceType: true,
        backedUp: true,
        lastUsedAt: true,
        createdAt: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  async deletePasskey(userId: string, passkeyId: string): Promise<void> {
    const passkey = await this.prisma.passkey.findUnique({
      where: { id: passkeyId }
    });

    if (!passkey) {
      throw new NotFoundException('Passkey not found');
    }

    if (passkey.userId !== userId) {
      throw new BadRequestException('You can only delete your own passkeys');
    }

    await this.prisma.passkey.delete({
      where: { id: passkeyId }
    });
  }

  async updatePasskeyName(userId: string, passkeyId: string, friendlyName: string): Promise<void> {
    const passkey = await this.prisma.passkey.findUnique({
      where: { id: passkeyId }
    });

    if (!passkey) {
      throw new NotFoundException('Passkey not found');
    }

    if (passkey.userId !== userId) {
      throw new BadRequestException('You can only update your own passkeys');
    }

    await this.prisma.passkey.update({
      where: { id: passkeyId },
      data: { friendlyName }
    });
  }

  async userHasPasskeys(email: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { passkeys: { select: { id: true } } }
    });

    return user ? user.passkeys.length > 0 : false;
  }

  private async storeChallenge(
    challenge: string,
    type: 'registration' | 'authentication',
    email?: string,
    userId?: string
  ): Promise<void> {
    const expiresAt = new Date(Date.now() + CHALLENGE_EXPIRY_MINUTES * 60 * 1000);

    await this.prisma.webAuthnChallenge.create({
      data: {
        challenge,
        type,
        email: email?.toLowerCase(),
        userId,
        expiresAt
      }
    });
  }

  private async getAndValidateChallenge(
    clientDataJSON: unknown,
    type: 'registration' | 'authentication',
    email?: string
  ) {
    if (typeof clientDataJSON !== 'string' || !clientDataJSON) return null;

    let challengeFromClient: string;
    try {
      const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf-8'));
      if (typeof clientData?.challenge !== 'string' || !clientData.challenge) return null;
      challengeFromClient = clientData.challenge;
    } catch {
      return null;
    }

    const challengeRecord = await this.prisma.webAuthnChallenge.findFirst({
      where: {
        challenge: challengeFromClient,
        type,
        expiresAt: { gt: new Date() },
        ...(email ? { email: email.toLowerCase() } : {})
      }
    });

    return challengeRecord;
  }

  private async consumeChallenge(tx: Prisma.TransactionClient, id: string): Promise<void> {
    const consumed = await tx.webAuthnChallenge.deleteMany({
      where: { id, expiresAt: { gt: new Date() } }
    });
    if (consumed.count !== 1) {
      throw new BadRequestException('Invalid or expired passkey challenge');
    }
  }

  async cleanupExpiredChallenges(): Promise<number> {
    let total = 0;
    for (let i = 0; i < CLEANUP_MAX_BATCHES; i++) {
      const stale = await this.prisma.webAuthnChallenge.findMany({
        where: { expiresAt: { lt: new Date() } },
        select: { id: true },
        take: CLEANUP_BATCH
      });
      if (stale.length === 0) break;
      const result = await this.prisma.webAuthnChallenge.deleteMany({
        where: { id: { in: stale.map((row) => row.id) } }
      });
      total += result.count;
      if (stale.length < CLEANUP_BATCH) break;
    }
    return total;
  }
}
