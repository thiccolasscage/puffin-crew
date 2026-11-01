#!/usr/bin/env node
'use strict';
// Stdio MCP server ("crew") that Claude Code and Codex load for each agent.
// It speaks newline-delimited JSON-RPC 2.0 and forwards tool calls to the
// app's bridge, tagged with this agent's id and token (from the environment).

const http = require('http');
const { TOOLS } = require('./tools');

const BRIDGE = process.env.CREW_BRIDGE_URL;
const AGENT_ID = process.env.CREW_AGENT_ID;
const TOKEN = process.env.CREW_AGENT_TOKEN;

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function callBridge(name, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ agentId: AGENT_ID, token: TOKEN, name, args });
    const req = http.request(
      `${BRIDGE}/tool`,
      { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: 0 },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({ ok: false, text: `Bad reply from the crew app: ${data.slice(0, 200)}` });
          }
        });
      }
    );
    req.on('error', (e) => resolve({ ok: false, text: `Can't reach the crew app (${e.message}). Is Puffin Crew still running?` }));
    req.end(body);
  });
}

async function onMessage(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'crew', version: '0.1.0' },
        instructions: 'Crew tools: delegate work, wait for reports, report back, ask the human, remember.',
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const name = params && params.name;
    if (!TOOLS.some((t) => t.name === name)) {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
      return;
    }
    const r = await callBridge(name, (params && params.arguments) || {});
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: r.text }], isError: !r.ok } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
  // notifications (no id) need no reply
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      continue;
    }
    onMessage(msg).catch((e) => msg.id != null && send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(e.message || e) } }));
  }
});
process.stdin.on('end', () => process.exit(0));
