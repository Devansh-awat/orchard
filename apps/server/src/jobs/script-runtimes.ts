export const SCRIPT_RUNTIMES = ['bash', 'python', 'node'] as const;

export type ScriptRuntime = (typeof SCRIPT_RUNTIMES)[number];

export interface ScriptRuntimeSpec {
  image: string;
  extension: string;
  interpreter: string[];
}

const DEFAULTS: Record<ScriptRuntime, ScriptRuntimeSpec> = {
  bash: {
    image:
      'debian:12.15-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc',
    extension: 'sh',
    interpreter: ['bash']
  },
  python: {
    image:
      'python:3.12.16-slim@sha256:5e2bdb1b0d542d5039cffb8181c65930093949194a65c365dfb1b0fe13a4fa5b',
    extension: 'py',
    interpreter: ['python']
  },
  node: {
    image:
      'node:22.23.5-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee',
    extension: 'js',
    interpreter: ['node']
  }
};

export function scriptRuntimeSpec(runtime: ScriptRuntime): ScriptRuntimeSpec {
  const spec = DEFAULTS[runtime];
  const override = process.env[`JOB_RUNTIME_IMAGE_${runtime.toUpperCase()}`];
  return override ? { ...spec, image: override } : spec;
}

export function scriptFileName(runtime: ScriptRuntime, stepOrder: number): string {
  return `step-${stepOrder}.${DEFAULTS[runtime].extension}`;
}
