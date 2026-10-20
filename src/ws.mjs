// WebSocket client framing (RFC 6455) over an arbitrary byte stream.
//
// The Codex app-server daemon listens on a Unix domain socket and speaks
// WebSocket on it. Node cannot open AF_UNIX sockets on Windows, so we run
// `codex app-server proxy` (stdio <-> control socket) and speak WebSocket over
// the child's stdin/stdout. This module only does the handshake and framing.

import { randomBytes, createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

export function buildHandshake(key, host = 'localhost', path = '/') {
  return (
    `GET ${path} HTTP/1.1\r\n` +
    `Host: ${host}\r\n` +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Key: ${key}\r\n` +
    'Sec-WebSocket-Version: 13\r\n\r\n'
  );
}

export function acceptFor(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export function encodeFrame(opcode, payload, mask = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? '', 'utf8');
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode
  if (!mask) return Buffer.concat([header, data]);
  header[1] |= 0x80;
  const maskKey = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ maskKey[i & 3];
  return Buffer.concat([header, maskKey, masked]);
}

// Incremental frame parser. Returns complete frames and keeps the remainder.
export class FrameParser {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const frames = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) break;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('websocket frame too large');
        len = Number(big);
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) break;
      let payload = this.buf.subarray(off, off + len);
      if (masked) {
        const key = this.buf.subarray(maskOff, maskOff + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      frames.push({ fin: (b0 & 0x80) !== 0, opcode: b0 & 0x0f, payload });
      this.buf = this.buf.subarray(off + len);
    }
    return frames;
  }
}

// Wraps a writable + readable pair (e.g. a child's stdin/stdout) as a
// WebSocket client. Calls onMessage(text) for each complete text message.
export class WebSocketOverStream {
  constructor({ readable, writable, onMessage, onClose, host, path }) {
    this.readable = readable;
    this.writable = writable;
    this.onMessage = onMessage;
    this.onClose = onClose ?? (() => {});
    this.host = host ?? 'localhost';
    this.path = path ?? '/';
    this.parser = new FrameParser();
    this.fragments = null;
    this.open = false;
    this.closed = false;
  }

  connect(timeoutMs = 10000) {
    const key = randomBytes(16).toString('base64');
    const expected = acceptFor(key);
    return new Promise((resolve, reject) => {
      let head = Buffer.alloc(0);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('websocket handshake timed out'));
      }, timeoutMs);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        if (end < 0) return;
        cleanup();
        const text = head.subarray(0, end).toString('latin1');
        const rest = head.subarray(end + 4);
        const statusLine = text.split('\r\n')[0] ?? '';
        if (!/^HTTP\/1\.1 101\b/.test(statusLine)) {
          reject(new Error(`websocket handshake failed: ${statusLine}`));
          return;
        }
        const accept = /\r\nsec-websocket-accept:\s*(\S+)/i.exec(text)?.[1];
        if (accept !== expected) {
          reject(new Error('websocket handshake failed: bad Sec-WebSocket-Accept'));
          return;
        }
        this.open = true;
        this.readable.on('data', (c) => this.#onData(c));
        this.readable.on('end', () => this.#finish());
        if (rest.length) this.#onData(rest);
        resolve();
      };
      const onEnd = () => {
        cleanup();
        reject(new Error('stream ended during websocket handshake'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.readable.off('data', onData);
        this.readable.off('end', onEnd);
      };
      this.readable.on('data', onData);
      this.readable.on('end', onEnd);
      this.writable.write(buildHandshake(key, this.host, this.path));
    });
  }

  send(text) {
    if (!this.open || this.closed) throw new Error('websocket is not open');
    this.writable.write(encodeFrame(OP.TEXT, text));
  }

  close() {
    if (this.open && !this.closed) {
      try {
        this.writable.write(encodeFrame(OP.CLOSE, Buffer.from([0x03, 0xe8])));
      } catch {
        // stream already gone
      }
    }
    this.#finish();
  }

  #finish() {
    if (this.closed) return;
    this.closed = true;
    this.open = false;
    this.onClose();
  }

  #onData(chunk) {
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch (err) {
      process.stderr.write(`[session-manager] ${err.message}\n`);
      this.close();
      return;
    }
    for (const f of frames) {
      if (f.opcode === OP.PING) {
        this.writable.write(encodeFrame(OP.PONG, f.payload));
      } else if (f.opcode === OP.CLOSE) {
        this.close();
      } else if (f.opcode === OP.TEXT || f.opcode === OP.BINARY) {
        if (f.fin) this.onMessage(f.payload.toString('utf8'));
        else this.fragments = [f.payload];
      } else if (f.opcode === OP.CONT && this.fragments) {
        this.fragments.push(f.payload);
        if (f.fin) {
          const all = Buffer.concat(this.fragments);
          this.fragments = null;
          this.onMessage(all.toString('utf8'));
        }
      }
    }
  }
}
