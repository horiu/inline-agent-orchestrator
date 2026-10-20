import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { acceptFor, encodeFrame, FrameParser, OP, WebSocketOverStream } from '../src/ws.mjs';

test('accept key matches the RFC 6455 example', () => {
  assert.equal(acceptFor('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

for (const size of [5, 125, 126, 300, 65535, 70000]) {
  test(`masked frame round trip (${size} bytes)`, () => {
    const payload = Buffer.alloc(size, 'a');
    const frames = new FrameParser().push(encodeFrame(OP.TEXT, payload, true));
    assert.equal(frames.length, 1);
    assert.equal(frames[0].opcode, OP.TEXT);
    assert.ok(frames[0].fin);
    assert.deepEqual(frames[0].payload, payload);
  });
}

test('parser waits for split frames and handles several in one chunk', () => {
  const p = new FrameParser();
  const a = encodeFrame(OP.TEXT, 'first', false);
  const b = encodeFrame(OP.TEXT, 'second', false);
  const all = Buffer.concat([a, b]);
  assert.deepEqual(p.push(all.subarray(0, 3)), []);
  const frames = p.push(all.subarray(3));
  assert.deepEqual(frames.map((f) => f.payload.toString()), ['first', 'second']);
});

function serverSide(client, server) {
  // Plays the server: answer the handshake, then hand back a frame parser.
  return new Promise((resolve) => {
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      client.off('data', onData);
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head.toString('latin1'))[1];
      server.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`);
      resolve();
    };
    client.on('data', onData);
  });
}

test('handshake, messages, fragmentation, ping and close over streams', async () => {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const got = [];
  let closed = false;
  const ws = new WebSocketOverStream({
    readable: toClient,
    writable: toServer,
    onMessage: (t) => got.push(t),
    onClose: () => (closed = true),
  });
  const handshake = serverSide(toServer, toClient);
  const connected = ws.connect(2000);
  await handshake;
  await connected;

  const parser = new FrameParser();
  const fromClient = [];
  toServer.on('data', (c) => fromClient.push(...parser.push(c)));

  ws.send('{"method":"initialize"}');
  const first = encodeFrame(OP.TEXT, 'hel', false);
  first[0] &= 0x7f;
  toClient.write(Buffer.concat([first, encodeFrame(OP.CONT, 'lo', false), encodeFrame(OP.PING, 'p', false), encodeFrame(OP.TEXT, 'x', false)]));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(got, ['hello', 'x']);
  assert.equal(fromClient[0].opcode, OP.TEXT);
  assert.equal(fromClient[0].payload.toString(), '{"method":"initialize"}');
  assert.equal(fromClient[1].opcode, OP.PONG);
  assert.equal(fromClient[1].payload.toString(), 'p');

  toClient.write(encodeFrame(OP.CLOSE, Buffer.from([0x03, 0xe8]), false));
  await new Promise((r) => setImmediate(r));
  assert.ok(closed);
  assert.throws(() => ws.send('late'));
});

test('handshake rejects a non-101 answer', async () => {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const ws = new WebSocketOverStream({ readable: toClient, writable: toServer, onMessage() {} });
  const p = ws.connect(2000);
  toClient.write('HTTP/1.1 403 Forbidden\r\n\r\n');
  await assert.rejects(p, /403/);
});

test('handshake rejects a wrong accept key', async () => {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  const ws = new WebSocketOverStream({ readable: toClient, writable: toServer, onMessage() {} });
  const p = ws.connect(2000);
  toClient.write('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: nope\r\n\r\n');
  await assert.rejects(p, /Sec-WebSocket-Accept/);
});
