import { Inject, Injectable } from '@nestjs/common';
import { Doors, type UsersDoor } from '@orchard/graft-sdk/server';

type Profile = Parameters<UsersDoor['resolve']>[1];

@Injectable()
export class UsersService {
  constructor(@Inject(Doors.users) private readonly users: UsersDoor) {}

  findOrCreateByClerkId(clerkId: string, profile?: Profile) {
    return this.users.resolve(clerkId, profile);
  }
}
