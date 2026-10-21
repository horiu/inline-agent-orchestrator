// Helpers shared by the backends and the tools.

import { spawn } from 'node:child_process';

export class ToolError extends Error {}

// Runs a CLI without a shell (arguments contain prompts and JSON) and returns
// { code, stdout, stderr }. command: a name or path ("claude", "gh"), or an
// argv prefix such as ["node", "/path/to/cli.js"].
export function runCli(command, args, { cwd, timeoutMs = 60000 } = {}) {
  const [cmd, ...prefix] = Array.isArray(command) ? command : [command];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...prefix, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${cmd} ${args[0]}: timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export const iso = (sec) => (typeof sec === 'number' ? new Date(sec * 1000).toISOString() : null);
export const tail = (s, n) => (s.length > n ? '…' + s.slice(s.length - n) : s);

export function windowLabel(mins) {
  if (mins === 300) return '5h';
  if (mins === 10080) return 'weekly';
  if (typeof mins === 'number') return `${mins}min`;
  return 'unknown';
}
