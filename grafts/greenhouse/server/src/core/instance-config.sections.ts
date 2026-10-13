import { previewDomainConflict } from '../sandboxes/preview/preview-auth';

export const SANDBOX_RUNNERS = 'sandbox-runners';
export const SLACK_APP = 'slack-app';
export const LINEAR = 'linear';

export type SectionId = typeof SANDBOX_RUNNERS | typeof SLACK_APP | typeof LINEAR;

type Values = Record<string, string | null>;

const SANDBOX_RUNNER_NAMES = ['kubernetes', 'vercel'];
const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

const positiveInt = (value: string | null, name: string, max: number) => {
  const raw = (value || '').trim();
  if (!raw) return;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    throw new Error(`${name} must be a whole number between 1 and ${max}`);
  }
};

export function validateSandboxRunners(values: Values): void {
  const runner = (values.defaultRunner || '').trim();
  if (runner && !SANDBOX_RUNNER_NAMES.includes(runner)) {
    throw new Error(`defaultRunner must be one of ${SANDBOX_RUNNER_NAMES.join(', ')}`);
  }
  positiveInt(values.vercelVcpus, 'vercelVcpus', 8);
  positiveInt(values.vercelTimeoutMinutes, 'vercelTimeoutMinutes', 1440);
  const drive = (values.vercelDriveGiB || '').trim();
  if (drive) {
    const gib = Number(drive);
    if (!Number.isInteger(gib) || gib < 0 || gib > 16384) {
      throw new Error('vercelDriveGiB must be a whole number between 0 and 16384');
    }
  }
  const bridge = (values.bridgeBinaryUrl || '').trim();
  if (bridge && !/^https:\/\/[^\s/]+(\/[^\s]*)?$/.test(bridge)) {
    throw new Error('bridgeBinaryUrl must be a plain https:// address');
  }
  const sha = (values.bridgeBinarySha256 || '').trim();
  if (sha && !/^[0-9a-fA-F]{64}$/.test(sha)) {
    throw new Error('bridgeBinarySha256 must be the 64 character hex SHA-256 of the tarball');
  }
  const preview = (values.previewDomain || '').trim();
  if (preview && !HOSTNAME.test(preview)) {
    throw new Error('previewDomain must be a bare domain name such as preview.example.com');
  }
  if (preview) {
    const conflict = previewDomainConflict(preview, {
      cookieDomain: process.env.COOKIE_DOMAIN,
      frontendUrl: process.env.FRONTEND_URL,
      apiUrl: process.env.API_URL,
      platformOrigins: process.env.PLATFORM_ORIGINS
    });
    if (conflict) throw new Error(conflict);
  }
}

const SLACK_APP_ID = /^[A-Z0-9]{6,32}$/;

export function validateSlackApp(values: Values): void {
  const token = (values.botToken || '').trim();
  if (token && !token.startsWith('xoxb-')) {
    throw new Error('botToken must be a bot token starting with xoxb-');
  }
  const appId = (values.appId || '').trim();
  if (appId && !SLACK_APP_ID.test(appId)) {
    throw new Error('appId must look like A0123456789');
  }
}

export const SECTION_VALIDATORS: [SectionId, (values: Values) => void][] = [
  [SANDBOX_RUNNERS, validateSandboxRunners],
  [SLACK_APP, validateSlackApp]
];
