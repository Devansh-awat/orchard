import { Controller, Post, Body } from '@nestjs/common';
import { DockerService } from './docker.service';

// No @Auth() — the global SuperAdminGuard defaults to requiring superadmin
// when this decorator is absent. The /docker/build endpoint can compile and
// publish an image from any GitHub URL, so it must not be reachable by
// regular users (deployment-attached builds go through ProjectsService
// which performs its own RBAC check).
@Controller('docker')
export class DockerController {
  constructor(private readonly dockerService: DockerService) {}

  @Post('build')
  async buildAndPush(
    @Body() body: {
      repoUrl: string;
      branch: string;
      dockerfilePath: string;
      imageName: string;
      tag?: string;
      target?: string;
      buildFromRoot?: boolean;
    }
  ) {
    const image = await this.dockerService.buildAndPushFromGitHub(body);

    return {
      success: true,
      image
    };
  }
}
