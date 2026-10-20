// Fake `codex` executable for connector tests.
//   app-server daemon start -> prints one JSON object
//   app-server proxy        -> acts as the WebSocket server on stdio and
//                              answers `initialize` and `thread/read`
//   app-server              -> JSONL on stdio, same answers
import { createInterface } from 'node:readline';
import { acceptFor, FrameParser, encodeFrame, OP } from '../src/ws.mjs';

const args = process.argv.slice(2).join(' ');

function answer(msg) {
  if (msg.id === undefined) return null;
  if (msg.method === 'initialize') return { id: msg.id, result: { userAgent: 'fake-codex' } };
  if (msg.method === 'thread/read') return { id: msg.id, result: { thread: { id: msg.params.threadId, status: { type: 'idle' } } } };
  return { id: msg.id, error: { code: -32601, message: 'Method not found' } };
}

if (process.env.FAKE_CODEX_FAIL) {
  process.stderr.write('daemon unsupported\n');
  process.exit(3);
} else if (args === 'app-server daemon start') {
  process.stdout.write(JSON.stringify({ status: 'running', socketPath: '/tmp/fake.sock' }) + '\n');
} else if (args === 'app-server proxy') {
  let head = Buffer.alloc(0);
  let upgraded = false;
  const parser = new FrameParser();
  process.stdin.on('data', (chunk) => {
    if (!upgraded) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end < 0) return;
      const key = /sec-websocket-key:\s*(\S+)/i.exec(head.subarray(0, end).toString('latin1'))[1];
      process.stdout.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptFor(key)}\r\n\r\n`,
      );
      upgraded = true;
      chunk = head.subarray(end + 4);
      if (!chunk.length) return;
    }
    for (const f of parser.push(chunk)) {
      if (f.opcode === OP.CLOSE) process.exit(0);
      if (f.opcode !== OP.TEXT) continue;
      const reply = answer(JSON.parse(f.payload.toString('utf8')));
      // Split the reply into a fragmented message to exercise continuation frames.
      if (reply) {
        const text = Buffer.from(JSON.stringify(reply));
        const half = Math.floor(text.length / 2);
        const first = encodeFrame(OP.TEXT, text.subarray(0, half), false);
        first[0] &= 0x7f; // clear FIN
        process.stdout.write(Buffer.concat([first, encodeFrame(OP.CONT, text.subarray(half), false)]));
      }
    }
  });
} else if (args === 'app-server') {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const reply = answer(JSON.parse(line));
    if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
  });
} else {
  process.stderr.write(`unexpected args: ${args}\n`);
  process.exit(2);
}
