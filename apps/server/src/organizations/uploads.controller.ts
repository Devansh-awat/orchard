import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { Public } from '../auth/decorators';
import { StorageService } from './storage.service';

const SAFE_PATH = /^[a-zA-Z0-9][a-zA-Z0-9._@-]*(\/[a-zA-Z0-9][a-zA-Z0-9._@-]*)+$/;

export function isServableUploadPath(path: string): boolean {
  return SAFE_PATH.test(path) && !path.includes('..');
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
    const image = found.contentType?.startsWith('image/');
    res.setHeader('Content-Type', image ? found.contentType! : 'application/octet-stream');
    if (!image) res.setHeader('Content-Disposition', 'attachment');
    if (found.length !== undefined) res.setHeader('Content-Length', String(found.length));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    found.body.on('error', () => res.destroy());
    found.body.pipe(res);
  }
}
