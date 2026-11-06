import { BadRequestException } from '@nestjs/common';
import { uploadStorage } from '../instance-config/object-storage';

const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._@-]*(\/[a-zA-Z0-9][a-zA-Z0-9._@-]*)+$/;

export function uploadKeyOf(url: string): string | null {
  const target = uploadStorage();
  if (!target || typeof url !== 'string') return null;
  const base = `${target.publicUrl}/`;
  if (!url.startsWith(base)) return null;
  return url.slice(base.length);
}

export function keyInNamespace(key: string, namespace: string): boolean {
  if (!namespace || !SAFE_KEY.test(`${namespace}/x`)) return false;
  return SAFE_KEY.test(key) && !key.includes('..') && key.startsWith(`${namespace}/`);
}

export function urlInNamespace(url: string, namespace: string): boolean {
  const key = uploadKeyOf(url);
  return key !== null && keyInNamespace(key, namespace);
}

export function assertUploadUrlOwned(
  value: string | null | undefined,
  namespace: string | null,
  current: string | null,
  label: string
): void {
  if (!value || value === current) return;
  const key = uploadKeyOf(value);
  if (key === null) return;
  if (namespace && keyInNamespace(key, namespace)) return;
  throw new BadRequestException(`${label} must be a file uploaded to this resource`);
}
