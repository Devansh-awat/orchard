export const SCRIPT_RUNTIMES = ['bash', 'python', 'node'] as const;

export type ScriptRuntime = (typeof SCRIPT_RUNTIMES)[number];

export interface ScriptRuntimeSpec {
  image: string;
  extension: string;
  interpreter: string[];
}

const DEFAULTS: Record<ScriptRuntime, ScriptRuntimeSpec> = {
  bash: {
    image: 'debian:12-slim',
    extension: 'sh',
    interpreter: ['bash']
  },
  python: {
    image: 'python:3.12-slim',
    extension: 'py',
    interpreter: ['python']
  },
  node: {
    image: 'node:22-slim',
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
