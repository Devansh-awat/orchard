import { Inject, Injectable } from '@nestjs/common';
import { Doors, type AuthDoor } from '@orchardlabs/graft-sdk/server';

@Injectable()
export class SessionsService {
  constructor(@Inject(Doors.auth) private readonly auth: AuthDoor) {}

  validateSession(sessionId: string): Promise<boolean> {
    return this.auth.validateSession(sessionId);
  }
}
