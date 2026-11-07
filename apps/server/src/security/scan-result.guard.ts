import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { SCAN_TOKEN_HEADER } from './trivy-job';
import { TrivyScanService } from './trivy-scan.service';

@Injectable()
export class ScanResultGuard implements CanActivate {
  constructor(private readonly trivy: TrivyScanService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    const header = req.headers?.[SCAN_TOKEN_HEADER];
    await this.trivy.assertAcceptingResult(
      String(req.params?.id ?? ''),
      typeof header === 'string' ? header : undefined
    );
    return true;
  }
}
