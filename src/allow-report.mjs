#!/usr/bin/env node
// PreToolUse hook of the plugin (hooks/hooks.json). Worker conversations of
// the desktop app cannot be started with --allowedTools, so their `report`
// calls would stop at a permission prompt; this allows that one tool, which
// only appends to the local report mailbox. Any other tool is left alone
// (no output: the usual permission rules apply).
// Spec: code.claude.com/docs/en/hooks (PreToolUse, hookSpecificOutput).

import { pathToFileURL } from 'node:url';
import { MANAGER_TOOL_PREFIXES } from './backends/claude.mjs';

export const REPORT_TOOL = `${MANAGER_TOOL_PREFIXES[1]}__report`;

export function decide(input) {
  let toolName = null;
  try {
    toolName = JSON.parse(input).tool_name;
  } catch {
    return null;
  }
  if (toolName !== REPORT_TOOL) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'inline-agent-orchestrator: report は監視役への報告を書くだけなので確認なしで使う',
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let input = '';
  process.stdin.on('data', (d) => (input += d));
  process.stdin.on('end', () => {
    const out = decide(input);
    if (out) process.stdout.write(JSON.stringify(out));
  });
}
