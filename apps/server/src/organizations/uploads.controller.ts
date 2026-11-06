import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { Public } from '../auth/decorators';
import { StorageService } from './storage.service';
import { SERVABLE_IMAGE_TYPES } from './image-reencode';

const SAFE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._@-]*(\/[a-zA-Z0-9][a-zA-Z0-9._@-]*)+$/;

export function isServableUploadPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.includes('..');
}

const SERVABLE_TYPE_VALUES = new Set(Object.values(SERVABLE_IMAGE_TYPES));

export function servableImageType(path: string, stored: string | undefined): string | null {
  const declared = stored?.split(';')[0].trim().toLowerCase();
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const fromExt = SERVABLE_IMAGE_TYPES[ext];
  if (!fromExt) return null;
  if (declared && SERVABLE_TYPE_VALUES.has(declared)) return declared;
  return fromExt;
}

@Controller('uploads')
export class UploadsController {
  constructor(private readonly storage: StorageService) {}

  @Public()
  @Get('*path')
  async read(@Param('path') path: string | string[], @Res() res: ExpressResponse): Promise<void> {
    const joined = Array.isArray(path) ? path.join('/') : path;
    if (!isServableUploadPath(joined)) throw new NotFoundException();
    const found = await this.storage.readUpload(joined).catch(() => null);
    if (!found) throw new NotFoundException();
    const type = servableImageType(joined, found.contentType);
    res.setHeader('Content-Type', type ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', type ? 'inline' : 'attachment');
    if (found.length !== undefined) res.setHeader('Content-Length', String(found.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    found.body.on('error', () => res.destroy());
    found.body.pipe(res);
  }
}
