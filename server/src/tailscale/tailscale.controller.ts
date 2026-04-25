import { Controller, Get, Post, Delete, Param, Req, Body } from '@nestjs/common';
import { TailscaleService } from './tailscale.service';
import { UsersService } from '../users/users.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller('tailscale')
export class TailscaleController {
  constructor(
    private readonly tailscaleService: TailscaleService,
    private readonly usersService: UsersService,
  ) {}

  @Get('status')
  async getStatus(@Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
    return this.tailscaleService.getStatus(user.id);
  }

  @Post('link')
  async linkAccount(@Req() req: any, @Body() body: { apiKey: string }) {
    if (!body.apiKey || typeof body.apiKey !== 'string') {
      throw new Error('API key is required');
    }
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
    return this.tailscaleService.linkAccount(user.id, body.apiKey.trim());
  }

  @Delete('unlink')
  async unlinkAccount(@Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
    await this.tailscaleService.unlinkAccount(user.id);
    return { success: true };
  }

  @Get('deployment/:deploymentId')
  async getDeploymentStatus(@Param('deploymentId') deploymentId: string) {
    return this.tailscaleService.getDeploymentTailscaleStatus(deploymentId);
  }

  @Post('expose/:deploymentId')
  async exposeDeployment(@Param('deploymentId') deploymentId: string, @Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
    return this.tailscaleService.exposeDeployment(deploymentId, user.id);
  }

  @Post('unexpose/:deploymentId')
  async unexposeDeployment(@Param('deploymentId') deploymentId: string, @Req() req: any) {
    const user = await this.usersService.findOrCreateByClerkId(req.user.sub, {
      email: req.user.email,
    });
    await this.tailscaleService.unexposeDeployment(deploymentId, user.id);
    return { success: true };
  }
}
