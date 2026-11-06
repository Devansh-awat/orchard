import { BadRequestException } from '@nestjs/common';

export type ReencodedImage = {
  buffer: Buffer;
  contentType: 'image/png' | 'image/webp';
  extension: 'png' | 'webp';
};

export type ReencodeOptions = {
  maxPixels?: number;
  maxDimension?: number;
  format?: 'png' | 'webp';
  allowSvg?: boolean;
};

const RASTER_FORMATS = new Set(['png', 'jpeg', 'gif', 'webp', 'avif']);
const DEFAULT_MAX_PIXELS = 24_000_000;
const DEFAULT_MAX_DIMENSION = 2048;
const UNSAFE_SVG = /<!ENTITY|<!DOCTYPE[^>]*\[|href\s*=\s*["'](?!#|data:image\/)/i;

export const SERVABLE_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif'
};

export async function reencodeImage(
  input: Buffer,
  options: ReencodeOptions = {}
): Promise<ReencodedImage> {
  const maxPixels = options.maxPixels ?? DEFAULT_MAX_PIXELS;
  const maxDimension = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const format = options.format ?? 'webp';
  try {
    const sharp = (await import('sharp')).default;
    const probe = await sharp(input, { limitInputPixels: maxPixels }).metadata();
    const kind = probe.format;
    if (kind === 'svg') {
      if (!options.allowSvg || UNSAFE_SVG.test(input.toString('utf8', 0, 262144))) {
        throw new Error('svg not accepted');
      }
    } else if (!kind || !RASTER_FORMATS.has(kind)) {
      throw new Error('unsupported image format');
    }
    const animated = format === 'webp' && (probe.pages ?? 1) > 1;
    let pipeline = sharp(input, {
      limitInputPixels: maxPixels,
      failOn: 'error',
      animated,
      ...(kind === 'svg' ? { density: 144 } : {})
    })
      .rotate()
      .resize(maxDimension, maxDimension, { fit: 'inside', withoutEnlargement: kind !== 'svg' });
    pipeline =
      format === 'png' ? pipeline.png({ compressionLevel: 9 }) : pipeline.webp({ quality: 85 });
    const out = await pipeline.toBuffer();
    if (out.length === 0) throw new Error('empty output');
    return {
      buffer: out,
      contentType: format === 'png' ? 'image/png' : 'image/webp',
      extension: format
    };
  } catch {
    throw new BadRequestException("That file isn't a valid image");
  }
}
