import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  Param,
  Body,
  Req,
} from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('stats')
  async getStats() {
    return this.adminService.getStats();
  }

  // --- Users ---

  @Get('users')
  async getUsers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getAllUsers(
      parseInt(page || '1', 10),
      parseInt(limit || '20', 10),
      search,
    );
  }

  @Get('users/:id')
  async getUser(@Param('id') id: string) {
    return this.adminService.getUser(id);
  }

  @Patch('users/:id')
  async updateUser(
    @Param('id') id: string,
    @Body() body: { firstName?: string; lastName?: string; isSuperAdmin?: boolean },
    @Req() req: any,
  ) {
    return this.adminService.updateUser(id, req.auth.userId, body);
  }

  @Delete('users/:id')
  async deleteUser(@Param('id') id: string, @Req() req: any) {
    return this.adminService.deleteUser(id, req.auth.userId);
  }

  // --- Organizations ---

  @Get('organizations')
  async getOrganizations(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
  ) {
    return this.adminService.getAllOrganizations(
      parseInt(page || '1', 10),
      parseInt(limit || '20', 10),
      search,
    );
  }

  @Post('organizations')
  async createOrganization(
    @Body()
    body: {
      name: string;
      slug: string;
      description?: string;
      avatarUrl?: string;
      plan?: string;
      primaryOwnerEmail?: string;
    },
    @Req() req: any,
  ) {
    return this.adminService.createOrganization(body, req.auth?.userId);
  }

  @Patch('organizations/:id')
  async updateOrganization(
    @Param('id') id: string,
    @Body() body: { name?: string; description?: string },
  ) {
    return this.adminService.updateOrganization(id, body);
  }

  @Delete('organizations/:id')
  async deleteOrganization(@Param('id') id: string) {
    return this.adminService.deleteOrganization(id);
  }
}
