#!/usr/bin/env node
// MCP server (stdio). Spec: https://modelcontextprotocol.io/specification
// Messages are newline-delimited JSON-RPC 2.0. Logs go to stderr only.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { AppServerClient, daemonConnector, embeddedConnector } from './appserver.mjs';
import { claudeBackend } from './backends/claude.mjs';
import { codexBackend } from './backends/codex.mjs';
import { Store, agentOf } from './state.mjs';
import { refreshStatuslineCopy } from './setup.mjs';
import { createTools, ToolError } from './tools.mjs';
import { versionInfo } from './version.mjs';

export const SERVER_INFO = { name: 'inline-agent-orchestrator', version: '0.8.0' };

// Worker conversations (CSM_ROLE=worker) see only `report`.
export function toolsForRole(tools, role) {
  return role === 'worker' ? { report: tools.report } : tools;
}
const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export function createMcpServer({ tools, write }) {
  const send = (msg) => write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');
  const inFlight = new Map(); // request id -> AbortController (notifications/cancelled)

  function toolList() {
    return Object.entries(tools).map(([name, t]) => ({
      name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { readOnlyHint: Boolean(t.readOnly) },
    }));
  }

  async function callTool(params, signal) {
    const tool = tools[params?.name];
    if (!tool) return { isError: true, content: [{ type: 'text', text: `unknown tool: ${params?.name}` }] };
    try {
      const result = await tool.handler(params.arguments ?? {}, { signal });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `${err.name}: ${err.message}`;
      return { isError: true, content: [{ type: 'text', text: message }] };
    }
  }

  async function handle(msg) {
    const { id, method, params } = msg;
    if (method === undefined) return; // responses to requests we never send
    const isRequest = id !== undefined && id !== null;
    try {
      let result;
      switch (method) {
        case 'initialize': {
          const asked = params?.protocolVersion;
          result = {
            protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          };
          break;
        }
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: toolList() };
          break;
        case 'tools/call': {
          const controller = new AbortController();
          if (isRequest) inFlight.set(id, controller);
          try {
            result = await callTool(params, controller.signal);
          } finally {
            if (isRequest) inFlight.delete(id);
          }
          // The spec says not to answer a cancelled request.
          if (controller.signal.aborted) return;
          break;
        }
        case 'notifications/cancelled':
          inFlight.get(params?.requestId)?.abort();
          return;
        default:
          if (!isRequest) return; // notifications such as notifications/initialized
          send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
          return;
      }
      if (isRequest) send({ id, result });
    } catch (err) {
      if (isRequest) send({ id, error: { code: -32603, message: err.message } });
    }
  }

  function receive(line) {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) msg.forEach((m) => void handle(m));
    else void handle(msg);
  }

  return { receive, toolList };
}

export function main() {
  const agent = agentOf();
  const store = new Store();
  const cfg = store.config();
  let backend;
  let client = null;
  if (agent === 'claude') {
    backend = claudeBackend({ store, claudePath: cfg.claude.path, permissionMode: cfg.claude.permissionMode });
    try {
      // After an update, the status line copy follows this version.
      refreshStatuslineCopy(store.dir);
    } catch {
      // Best effort: the old copy keeps working.
    }
  } else {
    const connector = cfg.transport === 'embedded' ? embeddedConnector(cfg.codexPath) : daemonConnector(cfg.codexPath);
    // Connects lazily: worker conversations only call `report`, which never
    // touches the app-server, so they do not spawn proxies or daemons.
    client = new AppServerClient({ connector });
    backend = codexBackend({ client, store });
  }
  const { tools } = createTools({ backend, store, sys: { version: () => versionInfo({ agent, running: SERVER_INFO.version, dir: store.dir }) } });
  const server = createMcpServer({ tools: toolsForRole(tools, process.env.CSM_ROLE), write: (s) => process.stdout.write(s) });
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => server.receive(line));
  rl.on('close', () => {
    client?.close();
    process.exit(0);
  });
  process.stderr.write(`[inline-agent-orchestrator] ready (agent: ${agent}, role: ${process.env.CSM_ROLE ?? 'manager'}, state: ${store.dir})\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
