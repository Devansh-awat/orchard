import { NotFoundException } from '@nestjs/common';

export function isMalformedIdError(e: unknown): boolean {
  const err = e as { name?: string; code?: unknown; message?: unknown };
  return (
    !!err &&
    err.name === 'PrismaClientKnownRequestError' &&
    err.code === 'P2023' &&
    typeof err.message === 'string' &&
    err.message.includes('Error creating UUID')
  );
}

export function prismaHttpException(e: unknown): NotFoundException | null {
  return isMalformedIdError(e) ? new NotFoundException('Not found') : null;
}
