import { connect } from 'node:net';

function refusedOnce(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const finish = (refused: boolean) => {
      socket.destroy();
      resolve(refused);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(false));
    socket.once('error', (e: NodeJS.ErrnoException) => finish(e.code === 'ECONNREFUSED'));
  });
}

export async function portRefused(
  host: string,
  port: number,
  { timeoutMs = 1_500, attempts = 3, pauseMs = 2_000 } = {}
): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs));
    if (!(await refusedOnce(host, port, timeoutMs))) return false;
  }
  return true;
}
