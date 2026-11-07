import { Controller, Delete, Param, Post, Request } from '@nestjs/common';
import { Auth, RequireScope } from '../auth/decorators';
import { DatabaseShellService } from './database-shell.service';

function who(req: any) {
  return {
    email: req.user.email,
    username: req.user.username,
    firstName: req.user.firstName,
    lastName: req.user.lastName,
    imageUrl: req.user.imageUrl
  };
}

@Auth()
@Controller('databases')
export class DatabaseShellController {
  constructor(private readonly shell: DatabaseShellService) {}

  @Post(':id/shell')
  @RequireScope('exec')
  open(@Param('id') id: string, @Request() req) {
    return this.shell.open(id, req.user.sub, who(req));
  }

  @Delete(':id/shell/:pod')
  @RequireScope('exec')
  close(@Param('id') id: string, @Param('pod') pod: string, @Request() req) {
    return this.shell.close(id, pod, req.user.sub, who(req));
  }
}
