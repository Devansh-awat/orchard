import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { DockerService } from './docker.service';

const REQUIRED_FIELDS = ['repoUrl', 'branch', 'dockerfilePath', 'imageName'] as const;
const OPTIONAL_FIELDS = ['tag', 'target'] as const;

export function pickBuildRequest(body: unknown) {
  const raw = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const text = (field: string, required: boolean) => {
    const value = raw[field];
    if (value === undefined || value === null) {
      if (required) throw new BadRequestException(`${field} is required`);
      return undefined;
    }
    if (typeof value !== 'string' || (required && !value.trim())) {
      throw new BadRequestException(`${field} must be a non-empty string`);
    }
    return value;
  };
  const [repoUrl, branch, dockerfilePath, imageName] = REQUIRED_FIELDS.map(
    (field) => text(field, true) as string
  );
  const [tag, target] = OPTIONAL_FIELDS.map((field) => text(field, false));
  if (raw.buildFromRoot !== undefined && typeof raw.buildFromRoot !== 'boolean') {
    throw new BadRequestException('buildFromRoot must be a boolean');
  }
  return {
    repoUrl,
    branch,
    dockerfilePath,
    imageName,
    ...(tag !== undefined ? { tag } : {}),
    ...(target !== undefined ? { target } : {}),
    ...(raw.buildFromRoot !== undefined ? { buildFromRoot: raw.buildFromRoot as boolean } : {})
  };
}

// No @Auth(): the global SuperAdminGuard defaults to requiring superadmin
// when this decorator is absent. The /docker/build endpoint can compile and
// publish an image from any GitHub URL, so it must not be reachable by
// regular users (deployment-attached builds go through ProjectsService
// which performs its own RBAC check).
@Controller('docker')
export class DockerController {
  constructor(private readonly dockerService: DockerService) {}

  @Post('build')
  async buildAndPush(@Body() body: unknown) {
    const image = await this.dockerService.buildAndPushFromGitHub(pickBuildRequest(body));

    return {
      success: true,
      image
    };
  }
}
