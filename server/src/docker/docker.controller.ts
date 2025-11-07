import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { DockerService } from './docker.service';
import { AuthGuard } from '../auth/auth.guard';

@Controller('docker')
@UseGuards(AuthGuard)
export class DockerController {
  constructor(private readonly dockerService: DockerService) {}

  @Post('build')
  async buildAndPush(@Body() body: {
    repoUrl: string;
    branch: string;
    dockerfilePath: string;
    imageName: string;
    tag?: string;
    target?: string;
    buildFromRoot?: boolean;
  }) {
    const image = await this.dockerService.buildAndPushFromGitHub(body);
    
    return {
      success: true,
      image,
    };
  }
}

