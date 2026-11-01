'use strict';
// The tools every agent gets through the "crew" MCP server.
// Shared by the MCP shim (to list them) and the orchestrator (to run them).

const TOOLS = [
  {
    name: 'delegate',
    description:
      'Hand a piece of work to another agent in the crew. Returns at once with the new agent id; ' +
      'the agent works in parallel and reports back to you. Use wait_for_reports to block until it does, ' +
      'or end your turn and the report will be delivered to you as a new message.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: 'Role to give the work to (see list_team).' },
        task: { type: 'string', description: 'The full brief. The other agent sees only this, so include the context it needs.' },
        title: { type: 'string', description: 'Short title for the tree, under 60 characters.' },
        provider: { type: 'string', enum: ['claude', 'codex'], description: 'Optional: force a provider. Defaults to the role\'s provider.' },
        pace: { type: 'string', enum: ['thrifty', 'balanced', 'max'], description: 'Optional: model tier for this agent.' },
      },
      required: ['role', 'task'],
    },
  },
  {
    name: 'wait_for_reports',
    description:
      'Block until the agents you delegated to have reported back, then return their reports word for word. ' +
      'With no agent_ids it waits for all of your unfinished agents. Returns after at most about 90 seconds with whatever has arrived; ' +
      'reports that come later are delivered to you as a new message, so ending your turn is also fine.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_ids: { type: 'array', items: { type: 'string' } },
        timeout_s: { type: 'number', description: 'Optional, capped at the app\'s limit (90 by default).' },
      },
    },
  },
  {
    name: 'report',
    description:
      'Report your result to whoever gave you the work. Call this once, when the work is finished or you are blocked. ' +
      'Your summary is delivered unchanged, so make it complete: what you did, what changed, anything left open.',
    inputSchema: {
      type: 'object',
      properties: {
        summary: { type: 'string' },
        status: { type: 'string', enum: ['done', 'blocked', 'failed'], description: 'Default done.' },
      },
      required: ['summary'],
    },
  },
  {
    name: 'ask_human',
    description:
      'Ask the human a question and wait for the answer. Only for things you cannot work out yourself: their intent, ' +
      'a decision, or anything that sends, merges, deletes or decides for them. Offer options when you can. ' +
      'Waits about 90 seconds; if they haven\'t answered by then, their answer arrives later as a new message.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        options: { type: 'array', items: { type: 'string' }, description: '2 to 4 short choices. Optional.' },
      },
      required: ['question'],
    },
  },
  {
    name: 'remember',
    description:
      'Save one durable note to your role\'s memory. It is shown to every future agent with your role, in every project. ' +
      'Save preferences and lessons, not task status.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string' } },
      required: ['note'],
    },
  },
  {
    name: 'list_team',
    description: 'List the roles you can delegate to, their providers, and your own unfinished agents.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'approve_tool',
    description: 'Internal: permission prompts routed to the human\'s inbox. Do not call this yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        tool_name: { type: 'string' },
        input: { type: 'object' },
        tool_use_id: { type: 'string' },
      },
      required: ['tool_name'],
    },
  },
];

const CREW_TOOL_NAMES = TOOLS.filter((t) => t.name !== 'approve_tool').map((t) => `mcp__crew__${t.name}`);

module.exports = { TOOLS, CREW_TOOL_NAMES };
