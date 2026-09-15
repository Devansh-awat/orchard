import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Request,
  UseInterceptors,
  UploadedFile,
  BadRequestException
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OrganizationRole } from '@prisma/client';
import { OrganizationsService } from './organizations.service';
import { StorageService } from './storage.service';
import { Auth } from '../auth/decorators';

@Auth()
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly organizationsService: OrganizationsService,
    private readonly storageService: StorageService
  ) {}

  @Get('user')
  async getUserOrganizations(@Request() req) {
    return this.organizationsService.getUserOrganizations(req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get('slug/:slug')
  async getOrganizationBySlug(@Param('slug') slug: string, @Request() req) {
    return this.organizationsService.getOrganizationBySlug(slug, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id')
  async getOrganization(@Param('id') id: string, @Request() req) {
    return this.organizationsService.getOrganization(id, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/avatar')
  @UseInterceptors(FileInterceptor('file'))
  async uploadAvatar(
    @Param('id') organizationId: string,
    @UploadedFile() file: Express.Multer.File,
    @Request() req
  ) {
    if (!file) {
      throw new BadRequestException('No file provided');
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new BadRequestException('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed');
    }

    const maxSize = 5 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new BadRequestException('File size exceeds 5MB limit');
    }

    return this.organizationsService.uploadAvatar(
      organizationId,
      req.user.sub,
      file,
      this.storageService,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Delete(':id/avatar')
  async deleteAvatar(@Param('id') organizationId: string, @Request() req) {
    return this.organizationsService.deleteAvatar(
      organizationId,
      req.user.sub,
      this.storageService,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Get(':id/members')
  async getOrganizationMembers(@Param('id') organizationId: string, @Request() req) {
    return this.organizationsService.getOrganizationMembers(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/members/me')
  async getCurrentUserMembership(@Param('id') organizationId: string, @Request() req) {
    return this.organizationsService.getMembershipByUserId(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Patch(':id')
  async updateOrganization(
    @Param('id') organizationId: string,
    @Body() body: {
      name?: string;
      description?: string;
      backupR2Endpoint?: string | null;
      backupR2Bucket?: string | null;
      backupR2Region?: string | null;
      backupR2AccessKey?: string | null;
      backupR2SecretKey?: string | null;
      databasePublicIp?: string | null;
    },
    @Request() req
  ) {
    return this.organizationsService.updateOrganization(organizationId, req.user.sub, body || {}, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Get(':id/backup-settings')
  async getBackupSettings(@Param('id') organizationId: string, @Request() req) {
    return this.organizationsService.getBackupSettings(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/members/join')
  async superadminJoinOrganization(
    @Param('id') organizationId: string,
    @Body('role') role: OrganizationRole,
    @Request() req
  ) {
    return this.organizationsService.superadminJoinOrganization(
      organizationId,
      role || 'owner',
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Post(':id/members')
  async inviteMemberToOrganization(
    @Param('id') organizationId: string,
    @Body('email') email: string,
    @Body('role') role: OrganizationRole,
    @Request() req
  ) {
    return this.organizationsService.inviteMemberToOrganization(
      organizationId,
      email,
      role,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Get(':id/invitations')
  async getOrganizationInvitations(@Param('id') organizationId: string, @Request() req) {
    return this.organizationsService.getOrganizationInvitations(organizationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/invitations/:invitationId')
  async cancelInvitation(
    @Param('id') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Request() req
  ) {
    return this.organizationsService.cancelInvitation(invitationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Post(':id/invitations/:invitationId/resend')
  async resendInvitation(
    @Param('id') organizationId: string,
    @Param('invitationId') invitationId: string,
    @Request() req
  ) {
    return this.organizationsService.resendInvitation(invitationId, req.user.sub, {
      email: req.user.email,
      username: req.user.username,
      firstName: req.user.firstName,
      lastName: req.user.lastName,
      imageUrl: req.user.imageUrl
    });
  }

  @Delete(':id/members/:memberId')
  async removeMemberFromOrganization(
    @Param('id') organizationId: string,
    @Param('memberId') memberId: string,
    @Request() req
  ) {
    return this.organizationsService.removeMemberFromOrganization(
      organizationId,
      memberId,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }

  @Patch(':id/members/:memberId')
  async updateMemberRole(
    @Param('id') organizationId: string,
    @Param('memberId') memberId: string,
    @Body('role') role: OrganizationRole,
    @Request() req
  ) {
    return this.organizationsService.updateMemberRole(
      organizationId,
      memberId,
      role,
      req.user.sub,
      {
        email: req.user.email,
        username: req.user.username,
        firstName: req.user.firstName,
        lastName: req.user.lastName,
        imageUrl: req.user.imageUrl
      }
    );
  }
}
