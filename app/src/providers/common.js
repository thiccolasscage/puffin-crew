'use strict';
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Variables a parent Claude Code session sets that would confuse a child
// session (it would think it is the parent, or a nested tool call).
const STRIP_ENV = [
  'CLAUDECODE',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_REMOTE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_PID',
];

function childEnv(extra) {
  const env = { ...process.env };
  for (const k of STRIP_ENV) delete env[k];
  return { ...env, ...extra };
}

// Find a CLI on PATH (or at an explicit path from settings).
function which(cmd) {
  if (!cmd) return null;
  if (path.isAbsolute(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const finder = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(finder, [cmd], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.split(/\r?\n/).find(Boolean) || null;
}

// The MCP shim runs under the same runtime as this app: plain node in tests,
// the Electron binary (as node) in the desktop app.
function shimCommand() {
  const shim = path.join(__dirname, '..', 'mcp-shim.js');
  return { command: process.execPath, args: [shim], env: process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {} };
}

// Read newline-delimited JSON from a child's stdout.
function readJsonLines(stream, onObj, onText) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        onObj(JSON.parse(line));
      } catch {
        onText && onText(line);
      }
    }
  });
  stream.on('end', () => {
    const line = buf.trim();
    if (!line) return;
    try {
      onObj(JSON.parse(line));
    } catch {
      onText && onText(line);
    }
  });
}

function spawnTurn(cmd, args, { cwd, env, onObj, onStderr }) {
  let child;
  const done = new Promise((resolve) => {
    let stderr = '';
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ error: true, message: e.message });
      return;
    }
    readJsonLines(child.stdout, onObj, (text) => onStderr && onStderr(text));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on('error', (e) => resolve({ error: true, message: e.message }));
    child.on('close', (code, signal) => {
      if (code !== 0 && stderr.trim() && onStderr) onStderr(stderr.trim().slice(-2000));
      resolve({ error: code !== 0, code, signal });
    });
  });
  return {
    done,
    kill: () => {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 3000).unref();
      }
    },
  };
}

function tmpFile(name, contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'puffin-crew-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

module.exports = { childEnv, which, shimCommand, spawnTurn, readJsonLines, tmpFile };
