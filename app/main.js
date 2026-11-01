'use strict';
// Electron main process: one window, the orchestrator, and the bridge agents call into.

const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { Orchestrator } = require('./src/orchestrator');
const { createBridge } = require('./src/bridge');
const { createClaudeProvider } = require('./src/providers/claude');
const { createCodexProvider } = require('./src/providers/codex');
const { createMockProvider } = require('./src/providers/mock');
const { designTeam } = require('./src/team');
const { which } = require('./src/providers/common');

// CREW_DATA_DIR lets you keep a separate crew (and lets the screenshot script use a scratch one).
if (process.env.CREW_DATA_DIR) app.setPath('userData', path.resolve(process.env.CREW_DATA_DIR));

let win;
let orch;
let bridge;

function crewDir() {
  if (process.env.CREW_DIR) return path.resolve(process.env.CREW_DIR);
  const repoCrew = path.join(__dirname, '..', 'crew');
  return fs.existsSync(repoCrew) ? repoCrew : null;
}

async function boot() {
  const dataDir = app.getPath('userData');
  const holder = {};
  bridge = createBridge({ toolCall: (...a) => holder.orch.toolCall(...a) });
  await bridge.start();

  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  } catch {}
  const providers = {
    claude: createClaudeProvider({ bridge, command: saved.claudePath || 'claude' }),
    codex: createCodexProvider({ bridge, command: saved.codexPath || 'codex' }),
    mock: createMockProvider(),
  };
  orch = holder.orch = new Orchestrator({ dataDir, providers, crewDir: crewDir() });

  let pending = null;
  orch.on('update', ({ agentId }) => {
    if (!win || win.isDestroyed()) return;
    if (!pending) {
      pending = new Set();
      setTimeout(() => {
        const changed = [...pending];
        pending = null;
        if (win && !win.isDestroyed()) win.webContents.send('crew:update', { changed });
      }, 60);
    }
    if (agentId) pending.add(agentId);
  });
  orch.on('notify', ({ agentId, kind, text }) => {
    if (win && !win.isDestroyed() && win.isFocused()) return;
    if (!Notification.isSupported()) return;
    const a = orch.agents.get(agentId);
    const title = kind === 'report' ? `${a ? a.role : 'Agent'} reported back` : kind === 'approval' ? `${a ? a.role : 'Agent'} wants permission` : `${a ? a.role : 'Agent'} has a question`;
    const n = new Notification({ title, body: text });
    n.on('click', () => {
      if (!win) return;
      win.show();
      win.focus();
      win.webContents.send('crew:focus', { agentId });
    });
    n.show();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Puffin Crew',
    backgroundColor: '#0f1419',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

// Everything the window may ask the orchestrator to do.
const API = {
  state: () => {
    const s = orch.snapshot();
    s.agents = s.agents.map(({ transcript, ...a }) => ({ ...a, transcriptLength: transcript.length }));
    s.dataDir = app.getPath('userData');
    s.crewDir = crewDir();
    return s;
  },
  agent: (agentId) => orch.publicAgent(orch.getAgent(agentId)),
  startTask: (opts) => orch.startTask(opts),
  sendMessage: (agentId, text) => orch.sendMessage(agentId, text),
  stop: (agentId) => orch.stop(agentId),
  handoff: (agentId, provider) => orch.handoff(agentId, provider),
  setPace: (agentId, pace) => orch.setPace(agentId, pace),
  answer: (inboxId, answer) => orch.answer(inboxId, answer),
  dismiss: (inboxId) => orch.dismissInbox(inboxId),
  saveRoles: (roles) => orch.roles.save(roles),
  readMemory: (role) => orch.roles.readMemory(role),
  writeMemory: (role, text) => orch.roles.writeMemory(role, text),
  updateSettings: (patch) => orch.updateSettings(patch),
  // CREW_TEAM_OFFLINE=1 skips Claude and reads the description by keywords.
  designTeam: (text) => designTeam(text, { claudeBin: !process.env.CREW_TEAM_OFFLINE && orch.providers.claude.available() ? which(orch.settings.claudePath || 'claude') : null }),
  applyTeam: (team) => orch.applyTeam(team),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  },
  openFolder: (p) => shell.openPath(p),
};

ipcMain.handle('crew:invoke', async (_e, method, args) => {
  if (!Object.prototype.hasOwnProperty.call(API, method)) throw new Error(`Unknown method ${method}`);
  return API[method](...(Array.isArray(args) ? args : []));
});

app.whenReady().then(async () => {
  await boot();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (orch) orch.shutdown();
  if (bridge) bridge.closeAll();
});
