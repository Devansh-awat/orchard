import { randomBytes, createHmac } from 'crypto';

export const OTP_LENGTH = 6;
export const OTP_EXPIRY_MINUTES = 10;

const OTP_MODULUS = 10 ** OTP_LENGTH;
const OTP_UNBIASED_CEILING = Math.floor(2 ** 32 / OTP_MODULUS) * OTP_MODULUS;

/**
 * Generate a cryptographically secure 6-digit OTP code.
 *
 * Rejection sampling rather than a bare modulo: 2^32 is not a multiple of
 * 10^6, so `random % 10^6` would make the first 967296 codes very slightly
 * likelier than the rest. Draws landing in the short final bucket are
 * discarded instead, which costs about one retry in every 4400 codes.
 */
export function generateOtpCode(): string {
  let drawn: number;
  do {
    drawn = randomBytes(4).readUInt32BE(0);
  } while (drawn >= OTP_UNBIASED_CEILING);
  return (drawn % OTP_MODULUS).toString().padStart(OTP_LENGTH, '0');
}

/**
 * Keyed on the instance secret: a six-digit space is a million entries, so a
 * bare hash would hand every live code to anyone who can read the table.
 */
export function hashOtpCode(code: string): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('JWT_SECRET is required to hash sign-in codes');
  return createHmac('sha256', secret).update(code).digest('hex');
}
