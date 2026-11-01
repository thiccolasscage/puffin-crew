'use strict';
// Runs the native Claude Code CLI, one process per turn:
//   claude -p <prompt> --output-format stream-json --verbose
//          --mcp-config <crew server> --append-system-prompt <role + memory>
//          [--resume <session>] [--model <alias>]
//          --permission-prompt-tool mcp__crew__approve_tool   (permission prompts go to your inbox)

const { childEnv, which, shimCommand, spawnTurn, tmpFile } = require('./common');
const { CREW_TOOL_NAMES } = require('../tools');

function createClaudeProvider({ bridge, command = 'claude' } = {}) {
  let resolved;
  const bin = () => (resolved === undefined ? (resolved = which(command)) : resolved);

  return {
    label: 'Claude Code',
    available: () => !!bin(),
    run(ctx) {
      const shim = shimCommand();
      const mcp = {
        mcpServers: {
          crew: {
            type: 'stdio',
            command: shim.command,
            args: shim.args,
            env: { ...shim.env, CREW_BRIDGE_URL: bridge.url(), CREW_AGENT_ID: ctx.agent.id, CREW_AGENT_TOKEN: ctx.token },
          },
        },
      };
      const cfg = tmpFile('mcp.json', JSON.stringify(mcp));
      const args = [
        '-p',
        ctx.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--mcp-config',
        cfg.file,
        '--append-system-prompt',
        ctx.systemPrompt,
        '--allowedTools',
        CREW_TOOL_NAMES.join(','),
      ];
      if (ctx.resume) args.push('--resume', ctx.resume);
      if (ctx.model) args.push('--model', ctx.model);
      if (ctx.permissionMode === 'bypassPermissions') {
        args.push('--permission-mode', 'bypassPermissions');
      } else {
        if (ctx.permissionMode === 'acceptEdits') args.push('--permission-mode', 'acceptEdits');
        args.push('--permission-prompt-tool', 'mcp__crew__approve_tool');
      }

      const turn = spawnTurn(bin(), args, {
        cwd: ctx.cwd,
        // Crew tools block while agents wait on each other or on you.
        env: childEnv({ MCP_TOOL_TIMEOUT: String(6 * 60 * 60 * 1000) }),
        onObj: (obj) => handle(obj, ctx),
        onStderr: (text) => ctx.onEvent({ kind: 'system', text: `claude: ${text}` }),
      });
      turn.done.finally(cfg.cleanup);
      return turn;
    },
  };
}

function handle(obj, ctx) {
  if (!obj || typeof obj !== 'object') return;
  if (obj.session_id && (obj.type === 'system' || obj.type === 'result')) ctx.onSession(obj.session_id);
  if (obj.type === 'assistant' && obj.message && Array.isArray(obj.message.content)) {
    for (const part of obj.message.content) {
      if (part.type === 'text' && part.text && part.text.trim()) ctx.onEvent({ kind: 'assistant', text: part.text });
      else if (part.type === 'tool_use') ctx.onEvent({ kind: 'tool', name: part.name, input: part.input });
    }
  } else if (obj.type === 'result') {
    ctx.onEvent({
      kind: 'result',
      text: typeof obj.result === 'string' ? obj.result : '',
      isError: !!obj.is_error,
      usage: {
        costUsd: obj.total_cost_usd || 0,
        inputTokens: (obj.usage && (obj.usage.input_tokens || 0) + (obj.usage.cache_read_input_tokens || 0) + (obj.usage.cache_creation_input_tokens || 0)) || 0,
        outputTokens: (obj.usage && obj.usage.output_tokens) || 0,
      },
    });
  }
}

module.exports = { createClaudeProvider, handleClaudeEvent: handle };
