import * as dotenv from 'dotenv';
import { resolve } from 'path';
import { initDatadog } from './analytics/datadog';
import { startTelemetry } from './analytics/telemetry';

dotenv.config();
dotenv.config({ path: resolve(process.cwd(), '..', '.env'), override: false });
dotenv.config({ path: resolve(__dirname, '../../.env'), override: false });
initDatadog();
startTelemetry();
