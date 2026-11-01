'use strict';
// Drives the real MCP shim over stdio, through the real bridge, into the orchestrator.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Orchestrator } = require('../src/orchestrator');
const { createBridge } = require('../src/bridge');
const { createMockProvider } = require('../src/providers/mock');
const { handleClaudeEvent } = require('../src/providers/claude');
const { handleCodexEvent } = require('../src/providers/codex');
const { heuristicTeam, parseTeam } = require('../src/team');

function rpcClient(env) {
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-shim.js')], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buf = '';
  let next = 1;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const msg = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  return {
    call(method, params) {
      const id = next++;
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return new Promise((r) => pending.set(id, r));
    },
    notify(method) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
    },
    close() {
      child.stdin.end();
    },
  };
}

test('shim lists crew tools and forwards calls with the agent token', async () => {
  const orch = new Orchestrator({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'crew-shim-')), providers: { mock: createMockProvider() }, settings: { mockDelayMs: 5 } });
  orch.roles.save(orch.roles.list().map((r) => ({ ...r, provider: 'mock' })));
  const bridge = createBridge(orch);
  await bridge.start();
  // An agent that never runs a turn of its own: we drive its tools from the shim.
  const idle = { available: () => true, run: () => ({ done: new Promise(() => {}), kill() {} }) };
  orch.providers.idle = idle;
  const a = orch.getAgent(orch.startTask({ role: 'lead', task: 'x', provider: 'idle' }).id);

  const rpc = rpcClient({ CREW_BRIDGE_URL: bridge.url(), CREW_AGENT_ID: a.id, CREW_AGENT_TOKEN: a.token });
  const init = await rpc.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'crew');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  rpc.notify('notifications/initialized');

  const list = await rpc.call('tools/list', {});
  assert.deepEqual(list.result.tools.map((t) => t.name), ['delegate', 'wait_for_reports', 'report', 'ask_human', 'remember', 'list_team', 'approve_tool']);

  const team = await rpc.call('tools/call', { name: 'list_team', arguments: {} });
  assert.match(team.result.content[0].text, /developer \(mock/);

  const del = await rpc.call('tools/call', { name: 'delegate', arguments: { role: 'developer', task: 'make it', title: 'Make it' } });
  assert.match(del.result.content[0].text, /Delegated to developer/);

  const wait = await rpc.call('tools/call', { name: 'wait_for_reports', arguments: { timeout_s: 10 } });
  assert.match(wait.result.content[0].text, /## Report from developer .* "Make it" — done/);
  assert.match(wait.result.content[0].text, /Done: make it/);

  // Blocking question answered from "the inbox" while the call is in flight.
  const asked = rpc.call('tools/call', { name: 'ask_human', arguments: { question: 'Which colour?', options: ['Red', 'Blue'] } });
  await new Promise((r) => setTimeout(r, 100));
  const q = orch.inbox.find((i) => i.kind === 'question' && i.status === 'open');
  assert.equal(q.text, 'Which colour?');
  orch.answer(q.id, 'Blue');
  assert.equal((await asked).result.content[0].text, 'The human answered: Blue');

  const bad = await rpc.call('tools/call', { name: 'nope', arguments: {} });
  assert.equal(bad.error.code, -32602);

  // A wrong token is refused.
  const rogue = rpcClient({ CREW_BRIDGE_URL: bridge.url(), CREW_AGENT_ID: a.id, CREW_AGENT_TOKEN: 'guess' });
  const denied = await rogue.call('tools/call', { name: 'report', arguments: { summary: 'x' } });
  assert.equal(denied.result.isError, true);
  rogue.close();
  rpc.close();
  orch.stop(a.id);
  await bridge.stop();
});

test('Claude stream-json events map to transcript events', () => {
  const events = [];
  let session;
  const ctx = { onEvent: (e) => events.push(e), onSession: (s) => (session = s) };
  handleClaudeEvent({ type: 'system', subtype: 'init', session_id: 'abc' }, ctx);
  handleClaudeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }, ctx);
  handleClaudeEvent({ type: 'result', subtype: 'success', result: 'Hi', session_id: 'abc', total_cost_usd: 0.02, usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 5 } }, ctx);
  assert.equal(session, 'abc');
  assert.deepEqual(events[0], { kind: 'assistant', text: 'Hi' });
  assert.deepEqual(events[1], { kind: 'tool', name: 'Bash', input: { command: 'ls' } });
  assert.deepEqual(events[2].usage, { costUsd: 0.02, inputTokens: 10, outputTokens: 5 });
});

test('Codex exec --json events map to transcript events', () => {
  const events = [];
  let session;
  const ctx = { onEvent: (e) => events.push(e), onSession: (s) => (session = s) };
  handleCodexEvent({ type: 'thread.started', thread_id: 't-1' }, ctx);
  handleCodexEvent({ type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: 'Looking' } }, ctx);
  handleCodexEvent({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'npm test', aggregated_output: 'ok', exit_code: 0 } }, ctx);
  handleCodexEvent({ type: 'turn.completed', usage: { input_tokens: 4, cached_input_tokens: 6, output_tokens: 2 } }, ctx);
  assert.equal(session, 't-1');
  assert.equal(events[0].text, 'Looking');
  assert.equal(events[1].input, 'npm test');
  assert.deepEqual(events[2].usage, { inputTokens: 10, outputTokens: 2 });
});

test('team from plain English: keyword reading and JSON parsing', () => {
  const t = heuristicTeam('A developer writes the code. Codex reviews every change. Keep it cheap.');
  assert.deepEqual(t.roles.map((r) => r.name), ['lead', 'developer', 'reviewer']);
  assert.equal(t.roles.find((r) => r.name === 'reviewer').provider, 'codex');
  assert.equal(t.pace, 'thrifty');
  const p = parseTeam('Here you go:\n{"pace":"max","roles":[{"name":"Travel Manager","provider":"claude","description":"trips"}]}');
  assert.deepEqual(p.roles.map((r) => r.name), ['lead', 'travel-manager']);
  assert.equal(p.pace, 'max');
});
