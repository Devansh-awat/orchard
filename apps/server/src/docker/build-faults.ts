/**
 * Builder pods run inside a Kata VM, so every container that joins the pod
 * makes the runtime re-enumerate the hypervisor's threads by walking
 * /proc/<vmm-pid>/task and reading each `comm`. A thread that exits between
 * the directory listing and the read makes that walk return ENOENT, which
 * fails the container start outright:
 *
 *   Init container inject-build-args failed with exit code 128: StartError -
 *   failed to create containerd task: failed to create shim task: failed to
 *   get thread ids from hypervisor: open /proc/78145/task/78235/comm: no
 *   such file or directory
 *
 * The build never ran, so the message says nothing about the user's repo.
 * Callers use this to re-run the job instead of reporting a failure.
 *
 * Deliberately not matched: `StartError - failed to start containerd task
 * "<id>": 429`. That one is the pusher noticing its sibling BuildKit
 * container already died, i.e. a real build failure wearing a start error's
 * clothes, and retrying it would just burn another build.
 */
const SANDBOX_START_FAULTS = [
  /failed to get thread ids from hypervisor/i,
  /failed to create shim task/i,
  /failed to create containerd task/i,
];

export function isSandboxStartFault(message: string): boolean {
  if (!/\bStartError\b/.test(message)) return false;
  return SANDBOX_START_FAULTS.some((re) => re.test(message));
}
