import { Inject, Injectable, Scope } from '@nestjs/common';
import { INQUIRER } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { bindGraft, type DoorMeta } from './door';

const PUBLIC_USER = {
  id: true,
  email: true,
  username: true,
  firstName: true,
  lastName: true,
  imageUrl: true,
  githubUsername: true,
  isSuperAdmin: true
} as const;

@Injectable({ scope: Scope.TRANSIENT })
export class UsersDoorV1 {
  static readonly meta: DoorMeta = {
    name: 'users',
    version: 1,
    status: 'stable',
    capability: 'users.read'
  };

  constructor(
    @Inject(INQUIRER) parent: unknown,
    @Inject(PrismaService) private readonly prisma: PrismaService
  ) {
    bindGraft(parent, UsersDoorV1.meta);
  }

  get(id: string) {
    return this.prisma.user.findUnique({ where: { id }, select: PUBLIC_USER });
  }

  getMany(ids: string[]) {
    return this.prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: PUBLIC_USER
    });
  }

  findByUsername(username: string) {
    return this.prisma.user.findUnique({ where: { username }, select: PUBLIC_USER });
  }
}
