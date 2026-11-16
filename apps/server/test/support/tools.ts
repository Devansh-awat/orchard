import { execFileSync } from 'node:child_process';

export function toolAvailable(tool: string, args: string[]): boolean {
  try {
    execFileSync(tool, args, { stdio: 'ignore' });
    return true;
  } catch {
    if (process.env.CI) {
      throw new Error(`${tool} is not installed, and CI must run the tests that need it`);
    }
    return false;
  }
}
