import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import { ScanResultGuard } from '../src/security/scan-result.guard';
import { TrivyScanService } from '../src/security/trivy-scan.service';
import { SCAN_TOKEN_HEADER } from '../src/security/trivy-job';
import { createHash } from 'node:crypto';

const ctx = (headers: Record<string, string>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers, params: { id: 'scan-1' } }) })
  }) as any;

function guardFor(row: any) {
  const trivy = Object.create(TrivyScanService.prototype) as any;
  trivy.prisma = { imageScan: { findUnique: async () => row } };
  return new ScanResultGuard(trivy);
}

test('the result body is only read for a running scan presented with its token', async () => {
  const token = 'secret-token';
  const hash = createHash('sha256').update(token).digest('hex');
  const row = { scanner: 'trivy', status: 'running', tokenHash: hash };
  await assert.rejects(guardFor(row).canActivate(ctx({})), ForbiddenException);
  await assert.rejects(
    guardFor(row).canActivate(ctx({ [SCAN_TOKEN_HEADER]: 'wrong' })),
    ForbiddenException
  );
  await assert.rejects(
    guardFor({ ...row, status: 'done' }).canActivate(ctx({ [SCAN_TOKEN_HEADER]: token })),
    ForbiddenException
  );
  assert.equal(await guardFor(row).canActivate(ctx({ [SCAN_TOKEN_HEADER]: token })), true);
});
