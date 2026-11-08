import { BadRequestException } from '@nestjs/common';

export const MAX_EMAIL_LENGTH = 254;

export function normalizeEmail(email: string): string {
  return email.normalize('NFC').trim().toLowerCase();
}

export function normalizeBoundedEmail(email: string): string {
  if (typeof email !== 'string' || email.length > MAX_EMAIL_LENGTH * 2) {
    throw new BadRequestException('Enter a valid email address');
  }
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || normalized.length > MAX_EMAIL_LENGTH) {
    throw new BadRequestException('Enter a valid email address');
  }
  return normalized;
}
