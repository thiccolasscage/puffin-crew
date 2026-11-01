'use strict';
// A loopback HTTP endpoint the MCP shim forwards crew tool calls to.
// Each agent authenticates with its own token, so agents can't act as each other.
// Calls can block for a long time (waiting on other agents, or on you).

const http = require('http');

function createBridge(orchestrator) {
  let server;
  let port = 0;

  const handler = (req, res) => {
    if (req.method !== 'POST' || req.url !== '/tool') {
      res.writeHead(404).end();
      return;
    }
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => {
      body += c;
      if (body.length > 2_000_000) req.destroy();
    });
    req.on('end', async () => {
      let out;
      try {
        const { agentId, token, name, args } = JSON.parse(body || '{}');
        const text = await orchestrator.toolCall(agentId, token, name, args || {});
        out = { ok: true, text: String(text) };
      } catch (e) {
        out = { ok: false, text: String(e && e.message ? e.message : e) };
      }
      if (!res.writableEnded) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      }
    });
  };

  return {
    start() {
      return new Promise((resolve, reject) => {
        server = http.createServer(handler);
        server.requestTimeout = 0;
        server.headersTimeout = 60_000;
        server.keepAliveTimeout = 0;
        server.timeout = 0;
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          resolve(port);
        });
      });
    },
    url: () => `http://127.0.0.1:${port}`,
    stop: () => new Promise((r) => (server ? server.close(() => r()) : r())),
    closeAll: () => server && server.closeAllConnections && server.closeAllConnections(),
  };
}

module.exports = { createBridge };
