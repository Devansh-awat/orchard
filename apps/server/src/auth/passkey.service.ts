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
import { PrismaService } from '../prisma/prisma.service';
import { RateLimitService } from './rate-limit.service';

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
        userVerification: 'preferred',
        authenticatorAttachment: 'platform' // Prefer platform authenticators (Touch ID, Face ID, Windows Hello)
      },
      timeout: 60000 // 1 minute
    });

    // Store the challenge for verification
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

    // Retrieve and validate the challenge
    const challengeRecord = await this.getAndValidateChallenge(
      response.response.clientDataJSON,
      'registration',
      email
    );

    if (!challengeRecord) {
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

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    // Check if this credential already exists
    const existingPasskey = await this.prisma.passkey.findUnique({
      where: { credentialId: credential.id }
    });

    if (existingPasskey) {
      throw new BadRequestException('This passkey is already registered');
    }

    // Store the passkey
    const passkey = await this.prisma.passkey.create({
      data: {
        userId,
        credentialId: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: BigInt(credential.counter),
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp,
        transports: response.response.transports || [],
        aaguid: verification.registrationInfo.aaguid,
        friendlyName: friendlyName || 'Passkey'
      }
    });

    // Delete the used challenge
    await this.prisma.webAuthnChallenge.delete({
      where: { id: challengeRecord.id }
    });

    return { verified: true, passkeyId: passkey.id };
  }

  /**
   * Generate authentication options for signing in with a passkey.
   */
  async generateAuthenticationOptions(
    email?: string,
    ipAddress?: string
  ): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const { rpID } = getRpConfig();

    // Check rate limits if email is provided
    if (email && ipAddress) {
      await this.rateLimitService.checkRateLimit(email, 'email', 'passkey_auth');
      await this.rateLimitService.checkRateLimit(ipAddress, 'ip', 'passkey_auth');
    }

    let allowCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[] = [];

    // If email is provided, only allow passkeys for that user
    if (email) {
      const user = await this.prisma.user.findUnique({
        where: { email: email.toLowerCase() },
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

    // Store the challenge for verification
    await this.storeChallenge(options.challenge, 'authentication', email);

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

    // Find the passkey by credential ID
    const passkey = await this.prisma.passkey.findUnique({
      where: { credentialId: response.id },
      include: { user: true }
    });

    if (!passkey) {
      // Increment rate limit for IP on failure
      await this.rateLimitService.incrementRateLimit(ipAddress, 'ip', 'passkey_auth');
      throw new BadRequestException('Passkey not found');
    }

    // Check rate limits for the user's email
    await this.rateLimitService.checkRateLimit(passkey.user.email, 'email', 'passkey_auth');

    // Retrieve and validate the challenge
    const challengeRecord = await this.getAndValidateChallenge(
      response.response.clientDataJSON,
      'authentication'
    );

    if (!challengeRecord) {
      await this.rateLimitService.incrementRateLimit(passkey.user.email, 'email', 'passkey_auth');
      await this.rateLimitService.incrementRateLimit(ipAddress, 'ip', 'passkey_auth');
      throw new BadRequestException('Invalid or expired authentication challenge');
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
      await this.rateLimitService.incrementRateLimit(passkey.user.email, 'email', 'passkey_auth');
      await this.rateLimitService.incrementRateLimit(ipAddress, 'ip', 'passkey_auth');
      throw new BadRequestException('Passkey authentication verification failed');
    }

    if (!verification.verified) {
      await this.rateLimitService.incrementRateLimit(passkey.user.email, 'email', 'passkey_auth');
      await this.rateLimitService.incrementRateLimit(ipAddress, 'ip', 'passkey_auth');
      throw new BadRequestException('Passkey authentication failed');
    }

    // Update passkey counter for replay protection
    await this.prisma.passkey.update({
      where: { id: passkey.id },
      data: {
        counter: BigInt(verification.authenticationInfo.newCounter),
        lastUsedAt: new Date()
      }
    });

    // Delete the used challenge
    await this.prisma.webAuthnChallenge.delete({
      where: { id: challengeRecord.id }
    });

    // Reset rate limits on success
    await this.rateLimitService.resetRateLimit(passkey.user.email, 'email', 'passkey_auth');
    await this.rateLimitService.resetRateLimit(ipAddress, 'ip', 'passkey_auth');

    return {
      verified: true,
      userId: passkey.userId,
      email: passkey.user.email
    };
  }

  /**
   * Get all passkeys for a user.
   */
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

  /**
   * Delete a passkey.
   */
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

  /**
   * Update a passkey's friendly name.
   */
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

  /**
   * Check if a user has any passkeys registered.
   */
  async userHasPasskeys(email: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      include: { passkeys: { select: { id: true } } }
    });

    return user ? user.passkeys.length > 0 : false;
  }

  /**
   * Store a challenge for later verification.
   */
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

  /**
   * Get and validate a challenge from the database.
   */
  private async getAndValidateChallenge(
    clientDataJSON: string,
    type: 'registration' | 'authentication',
    email?: string
  ) {
    // Decode the clientDataJSON to extract the challenge
    const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf-8'));
    const challengeFromClient = clientData.challenge;

    // Find the challenge in the database
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

  /**
   * Clean up expired challenges.
   */
  async cleanupExpiredChallenges(): Promise<number> {
    const result = await this.prisma.webAuthnChallenge.deleteMany({
      where: {
        expiresAt: { lt: new Date() }
      }
    });

    return result.count;
  }
}
