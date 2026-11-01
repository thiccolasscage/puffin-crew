'use strict';
// Runs the native Codex CLI, one process per turn:
//   codex exec --json [-m model] -c model_reasoning_effort=... -c mcp_servers.crew...  <prompt>
//   codex exec --json ... resume <thread id> <prompt>
// Codex has no appended system prompt, so the role brief rides on the first prompt.
// Codex can't route permission prompts to an MCP tool, so it runs in its
// workspace-write sandbox without asking; ask_human still reaches your inbox.

const { childEnv, which, shimCommand, spawnTurn } = require('./common');

function tomlString(s) {
  return JSON.stringify(String(s)); // JSON strings are valid TOML basic strings
}

function createCodexProvider({ bridge, command = 'codex' } = {}) {
  let resolved;
  const bin = () => (resolved === undefined ? (resolved = which(command)) : resolved);

  return {
    label: 'Codex',
    available: () => !!bin(),
    run(ctx) {
      const shim = shimCommand();
      const env = { ...shim.env, CREW_BRIDGE_URL: bridge.url(), CREW_AGENT_ID: ctx.agent.id, CREW_AGENT_TOKEN: ctx.token };
      const envToml = '{' + Object.entries(env).map(([k, v]) => `${k}=${tomlString(v)}`).join(',') + '}';
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--sandbox',
        ctx.permissionMode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write',
        '-C',
        ctx.cwd,
        '-c',
        `mcp_servers.crew.command=${tomlString(shim.command)}`,
        '-c',
        `mcp_servers.crew.args=[${shim.args.map(tomlString).join(',')}]`,
        '-c',
        `mcp_servers.crew.env=${envToml}`,
        '-c',
        'mcp_servers.crew.tool_timeout_sec=21600',
      ];
      if (ctx.model) args.push('-m', ctx.model);
      if (ctx.effort) args.push('-c', `model_reasoning_effort=${tomlString(ctx.effort)}`);
      const prompt = ctx.resume ? ctx.prompt : `${ctx.systemPrompt}\n\n---\n\n${ctx.prompt}`;
      if (ctx.resume) args.push('resume', ctx.resume, prompt);
      else args.push(prompt);

      return spawnTurn(bin(), args, {
        cwd: ctx.cwd,
        env: childEnv({}),
        onObj: (obj) => handle(obj, ctx),
        onStderr: (text) => ctx.onEvent({ kind: 'system', text: `codex: ${text}` }),
      });
    },
  };
}

function handle(obj, ctx) {
  if (!obj || typeof obj !== 'object') return;
  const type = obj.type || (obj.msg && obj.msg.type);
  if (type === 'thread.started' && obj.thread_id) ctx.onSession(obj.thread_id);
  else if (type === 'item.completed' && obj.item) {
    const it = obj.item;
    const kind = it.type || it.item_type;
    if (kind === 'agent_message' && it.text) ctx.onEvent({ kind: 'assistant', text: it.text });
    else if (kind === 'command_execution') ctx.onEvent({ kind: 'tool', name: 'shell', input: it.command, text: it.aggregated_output ? String(it.aggregated_output).slice(-1500) : '' });
    else if (kind === 'file_change') ctx.onEvent({ kind: 'tool', name: 'file_change', input: (it.changes || []).map((c) => `${c.kind} ${c.path}`).join('\n') });
    else if (kind === 'mcp_tool_call') ctx.onEvent({ kind: 'tool', name: `mcp__${it.server}__${it.tool}`, input: it.arguments });
    else if (kind === 'web_search') ctx.onEvent({ kind: 'tool', name: 'web_search', input: it.query });
    else if (kind === 'error' && it.message) ctx.onEvent({ kind: 'error', text: it.message });
  } else if (type === 'turn.completed') {
    const u = obj.usage || {};
    ctx.onEvent({ kind: 'result', text: '', usage: { inputTokens: (u.input_tokens || 0) + (u.cached_input_tokens || 0), outputTokens: u.output_tokens || 0 } });
  } else if (type === 'turn.failed' || type === 'error') {
    const msg = (obj.error && (obj.error.message || obj.error)) || obj.message || 'Codex reported an error.';
    ctx.onEvent({ kind: 'error', text: String(msg) });
  }
}

module.exports = { createCodexProvider, handleCodexEvent: handle };
