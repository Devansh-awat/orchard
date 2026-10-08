import { BadRequestException } from '@nestjs/common';

export function parseRepoUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BadRequestException('repoUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new BadRequestException('repoUrl must be an https URL');
  }
  if (parsed.username || parsed.password) {
    throw new BadRequestException(
      'repoUrl must not contain credentials; Orchard authenticates with your linked GitHub account'
    );
  }
  return parsed;
}
