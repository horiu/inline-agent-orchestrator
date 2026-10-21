import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REPORT_TOOL, decide } from '../src/allow-report.mjs';

test('the hook allows only the plugin report tool', () => {
  const out = decide(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: REPORT_TOOL, tool_input: { kind: 'done', text: 'x' } }));
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'allow');
  for (const name of ['Bash', 'mcp__plugin_inline-agent-orchestrator_session-manager__start_session', `${REPORT_TOOL}x`])
    assert.equal(decide(JSON.stringify({ tool_name: name })), null, name);
  assert.equal(decide('not json'), null);
});

test('hooks.json matches exactly the report tool', () => {
  const hooks = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks.PreToolUse;
  assert.equal(hooks.length, 1);
  assert.ok(new RegExp(hooks[0].matcher).test(REPORT_TOOL));
  assert.ok(!new RegExp(hooks[0].matcher).test(`${REPORT_TOOL}_x`));
  assert.match(hooks[0].hooks[0].command, /allow-report\.mjs/);
});
