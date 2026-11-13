import { BadRequestException } from '@nestjs/common';

const GIT_REF_RE = /^[A-Za-z0-9._/-]+$/;
const DOCKERFILE_PATH_RE = /^[A-Za-z0-9._/\- ]+$/;
const DOCKERFILE_TARGET_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function isSafeGitRef(ref: unknown): ref is string {
  if (!ref || typeof ref !== 'string') return false;
  if (ref.length > 200) return false;
  if (ref.startsWith('-')) return false;
  if (ref.includes('..')) return false;
  return GIT_REF_RE.test(ref);
}

export function isSafeDockerfilePath(path: unknown): path is string {
  if (!path || typeof path !== 'string') return false;
  if (path.length > 500) return false;
  if (path.startsWith('/') || path.startsWith('\\')) return false;
  if (path.includes('..') || path.includes('\0')) return false;
  return DOCKERFILE_PATH_RE.test(path);
}

export function isSafeDockerfileTarget(target: unknown): target is string {
  return typeof target === 'string' && DOCKERFILE_TARGET_RE.test(target);
}

export function assertSafeBuildInputs(input: {
  branch?: string | null;
  dockerfilePath?: string | null;
  target?: string | null;
}): void {
  if (input.branch !== undefined && input.branch !== null && !isSafeGitRef(input.branch)) {
    throw new BadRequestException('Invalid branch name');
  }
  if (input.dockerfilePath && !isSafeDockerfilePath(input.dockerfilePath)) {
    throw new BadRequestException('Invalid Dockerfile path');
  }
  if (input.target && !isSafeDockerfileTarget(input.target)) {
    throw new BadRequestException('Invalid Dockerfile target');
  }
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@,+%]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
