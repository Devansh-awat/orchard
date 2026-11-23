import {
  BadGatewayException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { Writable } from 'node:stream';
import { KubernetesService } from './kubernetes.service';
import { LIST_SCRIPT, STAT_FILE_SCRIPT, parsePodListing, type PodFileEntry } from './pod-files';

export const EXEC_TIMEOUT_MS = 30_000;
export const LISTING_MAX_BYTES = 16 * 1024 * 1024;
export const DOWNLOAD_STALL_MS = 60_000;

const CONNECTION_LOST = 'The connection to the container was lost';

interface ExecSocket {
  close(): void;
  pause?(): void;
  resume?(): void;
  on?(event: 'close', listener: () => void): unknown;
}

@Injectable()
export class PodFilesService {
  constructor(private readonly kubernetes: KubernetesService) {}

  async list(
    namespace: string,
    pod: string,
    container: string,
    path: string
  ): Promise<PodFileEntry[]> {
    const result = await this.capture(namespace, pod, container, [
      '/bin/sh',
      '-c',
      LIST_SCRIPT,
      'sh',
      path
    ]);
    if (!result.success) this.failed(result.stderr, `No directory at ${path}`);
    return parsePodListing(result.stdout);
  }

  async assertReadableFile(
    namespace: string,
    pod: string,
    container: string,
    path: string
  ): Promise<void> {
    const result = await this.capture(namespace, pod, container, [
      '/bin/sh',
      '-c',
      STAT_FILE_SCRIPT,
      'sh',
      path
    ]);
    if (!result.success) this.failed(result.stderr, `No readable file at ${path}`);
  }

  async streamFile(
    namespace: string,
    pod: string,
    container: string,
    path: string,
    out: Writable,
    signal: AbortSignal,
    onStart?: () => void
  ): Promise<void> {
    const kc = this.requireKubeConfig();
    if (signal.aborted) return;
    const exec = new k8s.Exec(kc);

    await new Promise<void>((resolve, reject) => {
      const errChunks: Buffer[] = [];
      let socket: ExecSocket | undefined;
      let settled = false;
      let started = false;
      let waiting = false;
      let statusSeen = false;
      let failure: string | null = null;
      let stall: NodeJS.Timeout | undefined;
      const listening = new AbortController();

      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(stall);
        listening.abort();
        socket?.close();
        if (error && !signal.aborted) reject(error);
        else resolve();
      };
      const armStall = () => {
        clearTimeout(stall);
        stall = setTimeout(
          () => finish(new BadGatewayException('The download stalled')),
          DOWNLOAD_STALL_MS
        );
      };

      const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
          if (settled) return done();
          if (!started) {
            started = true;
            onStart?.();
          }
          armStall();
          if (out.write(chunk)) return done();
          waiting = true;
          socket?.pause?.();
          out.once('drain', () => {
            waiting = false;
            socket?.resume?.();
            done();
          });
        }
      });
      sink.on('finish', () => finish(failure ? new BadGatewayException(failure) : undefined));
      const stderr = new Writable({
        write(chunk: Buffer, _encoding, done) {
          errChunks.push(chunk);
          done();
        }
      });

      signal.addEventListener('abort', () => finish(), { once: true, signal: listening.signal });
      armStall();
      exec
        .exec(namespace, pod, container, ['cat', path], sink, stderr, null, false, (status) => {
          statusSeen = true;
          if (status.status !== 'Success') {
            failure =
              Buffer.concat(errChunks).toString('utf-8').trim() || 'The file could not be read';
          }
        })
        .then((ws) => {
          socket = ws as unknown as ExecSocket;
          if (settled) return socket.close();
          if (waiting) socket.pause?.();
          socket.on?.('close', () => {
            if (!statusSeen) finish(new BadGatewayException(CONNECTION_LOST));
          });
        })
        .catch((err: unknown) => {
          finish(new BadGatewayException(err instanceof Error ? err.message : String(err)));
        });
    });
  }

  private capture(
    namespace: string,
    pod: string,
    container: string,
    cmd: string[]
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    const kc = this.requireKubeConfig();
    const exec = new k8s.Exec(kc);

    return new Promise((resolve, reject) => {
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let bytes = 0;
      let socket: ExecSocket | undefined;
      let settled = false;
      let statusSeen = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (result: Error | { success: boolean; stdout: string; stderr: string }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket?.close();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      timer = setTimeout(
        () => settle(new BadGatewayException('The container did not answer in time')),
        EXEC_TIMEOUT_MS
      );
      const collect = (chunks: Buffer[]) =>
        new Writable({
          write(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            if (bytes > LISTING_MAX_BYTES) {
              settle(new BadGatewayException('The container sent too much output'));
            } else {
              chunks.push(chunk);
            }
            done();
          }
        });

      exec
        .exec(
          namespace,
          pod,
          container,
          cmd,
          collect(outChunks),
          collect(errChunks),
          null,
          false,
          (status) => {
            statusSeen = true;
            settle({
              success: status.status === 'Success',
              stdout: Buffer.concat(outChunks).toString('utf-8'),
              stderr: Buffer.concat(errChunks).toString('utf-8')
            });
          }
        )
        .then((ws) => {
          socket = ws as unknown as ExecSocket;
          if (settled) return socket.close();
          socket.on?.('close', () => {
            if (!statusSeen) settle(new BadGatewayException(CONNECTION_LOST));
          });
        })
        .catch((err: unknown) => {
          settle(new BadGatewayException(err instanceof Error ? err.message : String(err)));
        });
    });
  }

  private failed(stderr: string, notFound: string): never {
    if (stderr.trim()) throw new BadGatewayException(stderr.trim());
    throw new NotFoundException(notFound);
  }

  private requireKubeConfig(): k8s.KubeConfig {
    this.kubernetes.ensureKubeConfig();
    if (!this.kubernetes.kc) throw new ServiceUnavailableException('Kubernetes API not available');
    return this.kubernetes.kc;
  }
}
