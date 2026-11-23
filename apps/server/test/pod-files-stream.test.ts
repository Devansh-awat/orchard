import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import test, { mock } from 'node:test';
import * as k8s from '@kubernetes/client-node';
import { LISTING_MAX_BYTES, PodFilesService } from '../src/kubernetes/pod-files.service';

const kubernetes = { kc: {}, ensureKubeConfig() {} } as any;
const service = () => new PodFilesService(kubernetes);
const tick = () => new Promise((resolve) => setImmediate(resolve));

function collector() {
  const chunks: Buffer[] = [];
  const out = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    }
  });
  return { out, text: () => Buffer.concat(chunks).toString('utf8') };
}

class FakeSocket extends EventEmitter {
  closed = 0;
  paused = 0;
  resumed = 0;
  close() {
    this.closed += 1;
  }
  pause() {
    this.paused += 1;
  }
  resume() {
    this.resumed += 1;
  }
}

test('streamFile writes the file bytes and resolves once cat succeeds', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout, , , , status] = args;
    stdout.write('hello ');
    stdout.write('world');
    stdout.end();
    status({ status: 'Success' });
    return new FakeSocket();
  });
  try {
    const { out, text } = collector();
    let started = 0;
    await service().streamFile('ns', 'pod', 'app', '/a', out, new AbortController().signal, () => {
      started += 1;
    });
    assert.equal(text(), 'hello world');
    assert.equal(started, 1);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile rejects with the stderr of a failed cat before any byte is sent', async () => {
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout, stderr, , , status] = args;
    stderr.write('cat: /a: Permission denied');
    stdout.end();
    status({ status: 'Failure' });
    return new FakeSocket();
  });
  try {
    const { out } = collector();
    let started = 0;
    await assert.rejects(
      service().streamFile('ns', 'pod', 'app', '/a', out, new AbortController().signal, () => {
        started += 1;
      }),
      (err: any) => err.message === 'cat: /a: Permission denied'
    );
    assert.equal(started, 0);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile closes the exec socket and resolves when the client aborts', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    const [, , , , stdout] = args;
    stdout.write('part');
    return socket;
  });
  try {
    const { out, text } = collector();
    const abort = new AbortController();
    const running = service().streamFile('ns', 'pod', 'app', '/a', out, abort.signal);
    await tick();
    abort.abort();
    await running;
    assert.equal(text(), 'part');
    assert.equal(socket.closed, 1);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile does not start an exec for a request that is already aborted', async () => {
  let calls = 0;
  mock.method(k8s.Exec.prototype, 'exec', async () => {
    calls += 1;
    return new FakeSocket();
  });
  try {
    const { out } = collector();
    const abort = new AbortController();
    abort.abort();
    await service().streamFile('ns', 'pod', 'app', '/a', out, abort.signal);
    assert.equal(calls, 0);
  } finally {
    mock.restoreAll();
  }
});

test('streamFile pauses the exec socket while the client is not reading', async () => {
  const socket = new FakeSocket();
  let stdout: Writable | undefined;
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    stdout = args[4];
    return socket;
  });
  const pending: Array<() => void> = [];
  const out = new Writable({
    highWaterMark: 4,
    write(_chunk, _encoding, callback) {
      pending.push(callback);
    }
  });
  try {
    const running = service().streamFile(
      'ns',
      'pod',
      'app',
      '/a',
      out,
      new AbortController().signal
    );
    await tick();
    stdout!.write(Buffer.alloc(16));
    await tick();
    assert.equal(socket.paused, 1);
    assert.equal(socket.resumed, 0);
    pending.shift()!();
    await tick();
    assert.equal(socket.resumed, 1);
    stdout!.end();
    await running;
  } finally {
    mock.restoreAll();
  }
});

test('streamFile fails when the exec socket closes without a status', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    args[4].write('part');
    return socket;
  });
  try {
    const { out } = collector();
    const running = service().streamFile(
      'ns',
      'pod',
      'app',
      '/a',
      out,
      new AbortController().signal
    );
    await tick();
    socket.emit('close');
    await assert.rejects(running, /connection to the container was lost/);
  } finally {
    mock.restoreAll();
  }
});

test('list fails when the exec socket closes without a status', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async () => socket);
  try {
    const running = service().list('ns', 'pod', 'app', '/');
    await tick();
    socket.emit('close');
    await assert.rejects(running, /connection to the container was lost/);
  } finally {
    mock.restoreAll();
  }
});

test('list stops reading a listing that is too large', async () => {
  const socket = new FakeSocket();
  mock.method(k8s.Exec.prototype, 'exec', async (...args: any[]) => {
    args[4].write(Buffer.alloc(LISTING_MAX_BYTES + 1));
    return socket;
  });
  try {
    await assert.rejects(service().list('ns', 'pod', 'app', '/'), /too much output/);
    assert.equal(socket.closed, 1);
  } finally {
    mock.restoreAll();
  }
});
