import { BadRequestException } from '@nestjs/common';
import { uploadLimits } from '../http/upload-limits';

const MAX_BYTES = 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp'
};

export const PROVIDER_ICON_UPLOAD = uploadLimits(MAX_BYTES);

function sniff(buffer: Buffer): string | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return 'image/png';
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg';
  }
  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

export function assertProviderIcon(file: Express.Multer.File | undefined): Express.Multer.File {
  if (!file) throw new BadRequestException('No file provided');
  if (!(file.mimetype in EXTENSIONS) || sniff(file.buffer) !== file.mimetype) {
    throw new BadRequestException('Icons must be PNG, JPEG, or WebP');
  }
  if (file.size > MAX_BYTES) throw new BadRequestException('Icons must be 1 MB or smaller');
  return { ...file, originalname: `icon.${EXTENSIONS[file.mimetype]}` };
}
