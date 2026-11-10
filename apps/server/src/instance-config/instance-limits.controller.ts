import { BadRequestException, Body, Controller, Get, Put } from '@nestjs/common';
import { InstanceConfigService, type ConfigValues } from './instance-config.service';
import { LIMITS } from './instance-config.sections';
import {
  INSTANCE_LIMIT_NAMES,
  INSTANCE_LIMITS,
  NODE_PORT_EXPOSURE_ENV,
  NODE_PORT_EXPOSURE_FIELD,
  isInstanceLimitName,
  isLimitPinned,
  isNodePortExposurePinned,
  nodePortExposureEnabled,
  resolveLimit,
  storedLimit,
  storedLimitError,
  storedNodePortExposureValue
} from '../quotas/instance-limits';

interface LimitsBody {
  limits?: Record<string, unknown>;
  nodePortExposure?: boolean | null;
}

// Superadmin-only (default-deny: no @Auth()/@Public() decorator, so the global
// SuperAdminGuard requires a superadmin).
@Controller('admin/instance-limits')
export class InstanceLimitsController {
  constructor(private readonly config: InstanceConfigService) {}

  private state() {
    return {
      limits: INSTANCE_LIMIT_NAMES.map((name) => {
        const spec = INSTANCE_LIMITS[name];
        return {
          name,
          env: spec.env,
          unit: spec.unit,
          min: spec.min,
          offable: spec.offable,
          fallback: spec.fallback,
          stored: storedLimit(name),
          value: resolveLimit(name),
          pinned: isLimitPinned(name)
        };
      }),
      nodePortExposure: {
        env: NODE_PORT_EXPOSURE_ENV,
        enabled: nodePortExposureEnabled(),
        stored: storedNodePortExposureValue(),
        pinned: isNodePortExposurePinned()
      }
    };
  }

  @Get()
  async get() {
    await this.config.fresh();
    return this.state();
  }

  @Put()
  async save(@Body() body: LimitsBody) {
    const values: ConfigValues = {};
    for (const [name, raw] of Object.entries(body?.limits ?? {})) {
      if (!isInstanceLimitName(name)) throw new BadRequestException(`Unknown limit ${name}`);
      if (raw === null || raw === '') {
        values[name] = '';
        continue;
      }
      const error = storedLimitError(name, raw);
      if (error) throw new BadRequestException(error);
      values[name] = String(raw).trim().toLowerCase();
    }
    if (body && 'nodePortExposure' in body) {
      const flag = body.nodePortExposure;
      if (flag !== null && typeof flag !== 'boolean') {
        throw new BadRequestException('nodePortExposure must be true, false or null');
      }
      values[NODE_PORT_EXPOSURE_FIELD] = flag === null ? '' : String(flag);
    }
    await this.config.save(LIMITS, values);
    return this.state();
  }
}
