import { BadRequestException } from '@nestjs/common';

const POD_NAME_RE = /^[a-z0-9]([-.a-z0-9]{0,251}[a-z0-9])?$/;

export function isValidPodName(name: unknown): name is string {
  return typeof name === 'string' && POD_NAME_RE.test(name);
}

export function assertValidPodName(name: unknown): asserts name is string {
  if (!isValidPodName(name)) throw new BadRequestException('Invalid pod name');
}
