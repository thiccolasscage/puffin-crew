'use strict';
// The orchestrator owns the agent tree and the human's inbox.
//
// Agents are real Claude Code / Codex processes (see providers/). They talk to
// the orchestrator through the "crew" MCP tools (delegate, wait_for_reports,
// report, ask_human, remember, list_team). Reports travel up the tree unchanged.
//
// Turn model: an agent runs one turn at a time (one CLI process). When a turn
// ends, the orchestrator decides what happens next:
//   - it called report        -> done; its report goes to its parent
//   - it has unfinished kids  -> waiting; wakes when their reports arrive
//   - reports are queued      -> a new turn starts that delivers them
//   - otherwise               -> its last answer becomes its report (root: idle)
// The human can message any agent at any time; that starts (or queues) a turn.

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { RoleStore } = require('./roles');

const ACTIVE = new Set(['queued', 'running', 'waiting', 'asking']);
const PACES = ['thrifty', 'balanced', 'max'];
const DEFAULT_SETTINGS = {
  pace: 'balanced', // global: sets how many agents may run at once
  concurrency: { thrifty: 2, balanced: 4, max: 8 },
  models: {
    claude: { thrifty: 'haiku', balanced: 'sonnet', max: 'opus' },
    codex: { thrifty: '', balanced: '', max: '' }, // empty = Codex's default model
  },
  codexEffort: { thrifty: 'low', balanced: 'medium', max: 'high' },
  permissionMode: 'ask', // ask | acceptEdits | bypassPermissions
  // Claude Code moves MCP calls that run past ~2 minutes into the background,
  // so crew tools never block longer than this. After that, answers and
  // reports arrive as a new message that wakes the agent.
  blockSeconds: 90,
  maxDepth: 4,
  maxChildren: 8,
  defaultCwd: '',
  mockDelayMs: 600,
};

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}
function now() {
  return new Date().toISOString();
}
function clip(s, n) {
  s = String(s ?? '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

class Orchestrator extends EventEmitter {
  constructor({ dataDir, providers, crewDir, settings } = {}) {
    super();
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.providers = providers || {};
    this.roles = new RoleStore(dataDir, { crewDir });
    this.stateFile = path.join(dataDir, 'state.json');
    this.settingsFile = path.join(dataDir, 'settings.json');
    this.settings = this._loadSettings(settings);
    this.agents = new Map();
    this.inbox = [];
    this.runs = new Map(); // agentId -> { kill }
    this.waiters = new Map(); // agentId -> { ids, resolve, timer }
    this.inboxWaiters = new Map(); // inboxId -> resolve
    this._saveTimer = null;
    this._load();
  }

  // ---------- persistence ----------

  _loadSettings(overrides) {
    let saved = {};
    try {
      saved = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
    } catch {}
    return deepMerge(deepMerge(structuredClone(DEFAULT_SETTINGS), saved), overrides || {});
  }

  updateSettings(patch) {
    this.settings = deepMerge(this.settings, patch || {});
    fs.writeFileSync(this.settingsFile, JSON.stringify(this.settings, null, 2));
    this._emit();
    this._schedule();
    return this.settings;
  }

  _load() {
    let state;
    try {
      state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      return;
    }
    for (const a of state.agents || []) {
      if (ACTIVE.has(a.status)) {
        a.status = 'stopped';
        a.transcript.push({ t: now(), kind: 'system', text: 'The app closed while this agent was working. Send it a message to pick up where it left off.' });
      }
      a.pendingReports = a.pendingReports || [];
      a.queuedMessages = [];
      a.token = id('tok');
      this.agents.set(a.id, a);
    }
    for (const item of state.inbox || []) {
      if (item.status === 'open' && item.kind !== 'report') {
        item.status = 'expired';
        item.answer = 'The app closed before this was answered.';
      }
      this.inbox.push(item);
    }
  }

  _save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.flush(), 300);
    this._saveTimer.unref?.();
  }

  flush() {
    clearTimeout(this._saveTimer);
    const agents = [...this.agents.values()].map((a) => {
      const { queued, ...rest } = this.publicAgent(a);
      return { ...rest, transcript: rest.transcript.slice(-500) };
    });
    const tmp = this.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ agents, inbox: this.inbox.slice(-500) }));
    fs.renameSync(tmp, this.stateFile);
  }

  _emit(agentId) {
    this._save();
    this.emit('update', { agentId: agentId || null });
  }

  // ---------- views ----------

  publicAgent(a) {
    const out = { queued: a.queuedMessages.length };
    for (const [k, v] of Object.entries(a)) if (k !== 'token' && k !== 'queuedMessages' && !k.startsWith('_')) out[k] = v;
    return out;
  }

  snapshot() {
    return {
      agents: [...this.agents.values()].map((a) => this.publicAgent(a)),
      inbox: this.inbox,
      roles: this.roles.list(),
      settings: this.settings,
      providers: Object.fromEntries(
        Object.entries(this.providers).map(([k, p]) => [k, { available: p.available ? p.available() : true, label: p.label || k }])
      ),
    };
  }

  getAgent(agentId) {
    const a = this.agents.get(agentId);
    if (!a) throw new Error(`No agent ${agentId}`);
    return a;
  }

  children(agentId) {
    return [...this.agents.values()].filter((a) => a.parentId === agentId);
  }

  depth(a) {
    let d = 0;
    while (a.parentId && this.agents.has(a.parentId)) {
      a = this.agents.get(a.parentId);
      d++;
    }
    return d;
  }

  // ---------- starting work ----------

  startTask({ role = 'lead', task, title, provider, pace, cwd, parentId = null }) {
    if (!task || !String(task).trim()) throw new Error('A task needs a brief.');
    const r = this.roles.get(role);
    if (!r) throw new Error(`Unknown role "${role}". Roles: ${this.roles.list().map((x) => x.name).join(', ')}`);
    const parent = parentId ? this.getAgent(parentId) : null;
    const a = {
      id: id('ag'),
      parentId,
      role: r.name,
      title: clip(title || String(task).split('\n')[0], 70),
      task: String(task),
      provider: provider || r.provider || 'claude',
      pace: PACES.includes(pace) ? pace : r.pace || 'balanced',
      cwd: cwd || (parent && parent.cwd) || this.settings.defaultCwd || process.cwd(),
      status: 'queued',
      sessionId: null,
      sessionProvider: null,
      createdAt: now(),
      updatedAt: now(),
      transcript: [],
      report: null,
      pendingReports: [],
      queuedMessages: [],
      allowedTools: [],
      usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
      token: id('tok'),
      handoffFrom: null,
    };
    a.provider = this._resolveProvider(a, a.provider);
    a.transcript.push({ t: now(), kind: 'user', text: a.task, from: parent ? `${parent.role} (${parent.id})` : 'you' });
    this.agents.set(a.id, a);
    a.queuedMessages.push(this._firstPrompt(a));
    this._emit(a.id);
    this._schedule();
    return this.publicAgent(a);
  }

  _resolveProvider(a, wanted) {
    const p = this.providers[wanted];
    if (p && (!p.available || p.available())) return wanted;
    const fallback = ['claude', 'codex', 'mock'].find((k) => this.providers[k] && (!this.providers[k].available || this.providers[k].available()));
    if (!fallback) return wanted;
    if (fallback !== wanted) {
      a.transcript.push({ t: now(), kind: 'system', text: `${wanted} isn't available on this computer, so this agent runs on ${fallback}.` });
    }
    return fallback;
  }

  _firstPrompt(a) {
    let text = a.task;
    if (a.handoffFrom) text = a.handoffFrom + '\n\n---\n\n' + text;
    return text;
  }

  systemPrompt(a) {
    const role = this.roles.get(a.role) || { name: a.role, instructions: '' };
    const parent = a.parentId ? this.agents.get(a.parentId) : null;
    const others = this.roles
      .list()
      .map((r) => `- ${r.name} (${r.provider}): ${r.description}`)
      .join('\n');
    const memory = this.roles.readMemory(a.role).trim();
    return [
      `You are an agent in a crew run by the Puffin Crew desktop app. Your role: ${role.name}. Your agent id: ${a.id}.`,
      parent
        ? `You were given this work by the ${parent.role} agent (${parent.id}). When you finish, call the crew tool "report" with a complete summary; it is delivered to them word for word.`
        : 'You were given this work by the human directly. Answer them in your final message; call "report" when the whole job is finished.',
      '',
      `## Your role\n${role.instructions || role.description || ''}`,
      '',
      `## The crew (delegate with the "delegate" tool)\n${others}`,
      '',
      '## How the crew works',
      '- Delegate work that is separable and big enough to be worth a fresh agent. Give each brief all the context it needs; the other agent sees nothing else.',
      '- After delegating, call wait_for_reports, or end your turn: reports arrive as a new message.',
      '- Reports from other agents are relayed unchanged. Check them before you rely on them.',
      '- Ask the human (ask_human) only when you are stuck or need a decision. Anything that sends, merges, deletes or decides for the human waits for their yes.',
      '- Save durable lessons and preferences with "remember". Not task status.',
      memory ? `\n## Your role's memory (from earlier work)\n${clip(memory, 6000)}` : '',
    ].join('\n');
  }

  modelFor(a) {
    const table = (this.settings.models || {})[a.provider] || {};
    return table[a.pace] || '';
  }

  // ---------- scheduling ----------

  _limit() {
    return (this.settings.concurrency || {})[this.settings.pace] || 4;
  }

  _busyCount() {
    // Agents blocked on a crew tool (waiting for reports or for you) don't count:
    // otherwise a parent waiting on its child could starve the child of a slot.
    let n = 0;
    for (const agentId of this.runs.keys()) {
      const a = this.agents.get(agentId);
      if (a && !a._blocked) n++;
    }
    return n;
  }

  _schedule() {
    const queued = [...this.agents.values()]
      .filter((a) => !this.runs.has(a.id) && a.queuedMessages.length && !['stopped'].includes(a.status))
      .sort((x, y) => x.updatedAt.localeCompare(y.updatedAt));
    for (const a of queued) {
      if (this._busyCount() >= this._limit()) {
        if (a.status !== 'queued' && a.status !== 'waiting') {
          a.status = 'queued';
          this._emit(a.id);
        }
        continue;
      }
      const prompt = a.queuedMessages.shift();
      this._runTurn(a, prompt);
    }
  }

  _runTurn(a, prompt) {
    const provider = this.providers[a.provider];
    if (!provider) {
      a.status = 'failed';
      a.transcript.push({ t: now(), kind: 'error', text: `No provider "${a.provider}".` });
      this._afterTurn(a, { error: true });
      return;
    }
    // A different provider can't resume another provider's session.
    const resume = a.sessionProvider === a.provider ? a.sessionId : null;
    a.status = 'running';
    a.updatedAt = now();
    a._lastText = '';
    this._emit(a.id);

    const handle = provider.run({
      agent: this.publicAgent(a),
      prompt,
      resume,
      systemPrompt: this.systemPrompt(a),
      model: this.modelFor(a),
      effort: (this.settings.codexEffort || {})[a.pace],
      cwd: a.cwd,
      token: a.token,
      permissionMode: this.settings.permissionMode,
      mockDelayMs: this.settings.mockDelayMs,
      callTool: (name, args) => this.toolCall(a.id, a.token, name, args),
      onSession: (sid) => {
        a.sessionId = sid;
        a.sessionProvider = a.provider;
        this._save();
      },
      onEvent: (ev) => this._onEvent(a, ev),
    });
    this.runs.set(a.id, handle);
    Promise.resolve(handle.done)
      .then((res) => this._afterTurn(a, res || {}))
      .catch((err) => {
        a.transcript.push({ t: now(), kind: 'error', text: String(err && err.message ? err.message : err) });
        this._afterTurn(a, { error: true });
      });
  }

  _onEvent(a, ev) {
    if (!ev) return;
    const entry = { t: now(), kind: ev.kind, text: ev.text != null ? String(ev.text) : '' };
    if (ev.name) entry.name = ev.name;
    if (ev.input !== undefined) entry.input = clip(typeof ev.input === 'string' ? ev.input : JSON.stringify(ev.input), 2000);
    if (ev.kind === 'assistant' && ev.text) a._lastText = String(ev.text);
    if (ev.kind === 'result') {
      if (ev.text) a._lastText = String(ev.text);
      if (ev.usage) {
        a.usage.costUsd += Number(ev.usage.costUsd || 0);
        a.usage.inputTokens += Number(ev.usage.inputTokens || 0);
        a.usage.outputTokens += Number(ev.usage.outputTokens || 0);
      }
      if (!ev.isError) {
        this._emit(a.id);
        return; // the final text already appeared as an assistant message
      }
      entry.kind = 'error';
    }
    // Crew tool calls are logged by the tool handler with better detail.
    if (entry.kind === 'tool' && /^mcp__crew__/.test(entry.name || '')) return;
    a.transcript.push(entry);
    a.updatedAt = now();
    this._emit(a.id);
  }

  _afterTurn(a, res) {
    this.runs.delete(a.id);
    a._blocked = false;
    a.updatedAt = now();
    const reported = a._reportedThisTurn;
    const humanTurn = a._humanTurn;
    a._reportedThisTurn = false;
    a._humanTurn = false;
    const undelivered = a.pendingReports.some((r) => !r.delivered);
    const unfinished = this.children(a.id).filter((k) => ACTIVE.has(k.status));
    const askingYou = this.inbox.some((i) => i.agentId === a.id && i.status === 'open' && i.kind === 'question');

    if (a._handingOff) {
      a._handingOff = false;
      if (a.status !== 'stopped') a.status = 'queued';
    } else if (a.status === 'stopped') {
      // stopped by the human; leave it
    } else if (res.error && !reported) {
      a.status = 'failed';
      const summary = `The agent failed. Its last output:\n${a._lastText || '(none)'}`;
      if (a.parentId && !humanTurn) this._deliverReport(a, { status: 'failed', summary, auto: true });
      else if (!a.parentId) this._notifyHuman(a, summary, 'failed');
    } else if (undelivered) {
      a.queuedMessages.push(this._reportsPrompt(a));
      a.status = 'queued';
    } else if (a.queuedMessages.length) {
      a.status = 'queued';
    } else if (askingYou && !reported) {
      a.status = 'asking';
    } else if (unfinished.length) {
      a.status = 'waiting';
    } else if (a.report) {
      a.status = a.report.status === 'done' ? 'done' : a.report.status;
      // You talked to a finished lead: its reply goes to your inbox.
      if (!a.parentId && humanTurn && !reported) this._notifyHuman(a, a._lastText);
    } else if (a.parentId) {
      // Finished without calling report: its last answer is the report.
      this._setReport(a, { status: 'done', summary: a._lastText || '(no output)', auto: true });
      a.status = 'done';
    } else {
      a.status = 'idle';
      this._notifyHuman(a, a._lastText);
    }
    this._emit(a.id);
    if (a.parentId) this._maybeWake(a.parentId);
    this._schedule();
  }

  _reportsPrompt(a) {
    const fresh = a.pendingReports.filter((r) => !r.delivered);
    fresh.forEach((r) => (r.delivered = true));
    const remaining = this.children(a.id).filter((k) => ACTIVE.has(k.status) && !k.report);
    const body = fresh.map(formatReport).join('\n\n');
    const tail = remaining.length
      ? `Still working: ${remaining.map((k) => `${k.role} (${k.id}) "${k.title}"`).join(', ')}.`
      : 'Everything you delegated has now reported back.';
    a.transcript.push({ t: now(), kind: 'system', text: `Delivered ${fresh.length} report(s).` });
    return `${body}\n\n${tail}`;
  }

  // ---------- reports ----------

  _setReport(a, { status, summary, auto }) {
    a.report = { status: status || 'done', summary: String(summary), at: now(), auto: !!auto };
    a.transcript.push({ t: now(), kind: 'report', text: a.report.summary, status: a.report.status, auto: !!auto });
    if (a.parentId) this._deliverReport(a, a.report);
    else this._notifyHuman(a, a.report.summary, a.report.status);
  }

  _deliverReport(child, report) {
    const parent = this.agents.get(child.parentId);
    if (!parent) return;
    parent.pendingReports.push({
      fromId: child.id,
      role: child.role,
      title: child.title,
      provider: child.provider,
      status: report.status,
      summary: report.summary,
      auto: !!report.auto,
      at: now(),
      delivered: false,
    });
    parent.transcript.push({ t: now(), kind: 'child-report', text: report.summary, fromId: child.id, role: child.role, status: report.status, auto: !!report.auto });
    this._emit(parent.id);
    this._checkWaiter(parent.id);
    this._maybeWake(parent.id, report.status !== 'done');
  }

  // Wake a parent that isn't running once all its agents have reported
  // (or at once, for a blocked or failed report). Reports go in one message.
  _maybeWake(parentId, urgent = false) {
    const p = this.agents.get(parentId);
    if (!p || this.runs.has(p.id) || p.status === 'stopped' || p.status === 'failed') return;
    if (!p.pendingReports.some((r) => !r.delivered)) return;
    const active = this.children(p.id).filter((k) => ACTIVE.has(k.status) && !k.report);
    if (active.length && !urgent) return;
    if (!p.queuedMessages.length) p.queuedMessages.push(this._reportsPrompt(p));
    p.status = 'queued';
    this._emit(p.id);
    setImmediate(() => this._schedule());
  }

  _notifyHuman(a, text, status) {
    // Root agents answer to the human: their result lands in the inbox.
    const open = this.inbox.find((i) => i.agentId === a.id && i.kind === 'report' && i.status === 'open');
    if (open) {
      open.text = String(text || '');
      open.createdAt = now();
      open.reportStatus = status || 'done';
    } else {
      this.inbox.push({ id: id('in'), agentId: a.id, kind: 'report', text: String(text || ''), reportStatus: status || 'done', status: 'open', createdAt: now() });
    }
    this.emit('notify', { agentId: a.id, kind: 'report', text: clip(text, 200) });
  }

  _checkWaiter(agentId) {
    const w = this.waiters.get(agentId);
    if (!w) return;
    const a = this.agents.get(agentId);
    const ids = w.ids || this.children(agentId).filter((k) => ACTIVE.has(k.status) || a.pendingReports.some((r) => r.fromId === k.id && !r.delivered)).map((k) => k.id);
    const reported = new Set(a.pendingReports.filter((r) => !r.delivered).map((r) => r.fromId));
    const doneIds = ids.filter((x) => reported.has(x) || !ACTIVE.has((this.agents.get(x) || {}).status));
    if (doneIds.length >= ids.length) w.finish();
  }

  // ---------- human actions ----------

  sendMessage(agentId, text) {
    const a = this.getAgent(agentId);
    if (!String(text || '').trim()) return this.publicAgent(a);
    a.transcript.push({ t: now(), kind: 'user', text: String(text), from: 'you' });
    a.queuedMessages.push(String(text));
    if (a.status === 'stopped' || a.status === 'failed') a.status = 'queued';
    a._humanTurn = true;
    a.updatedAt = now();
    this._emit(a.id);
    this._schedule();
    return this.publicAgent(a);
  }

  stop(agentId, { cascade = true } = {}) {
    const a = this.getAgent(agentId);
    a.queuedMessages = [];
    const run = this.runs.get(a.id);
    const wasActive = ACTIVE.has(a.status) || !!run;
    if (wasActive) {
      a.status = 'stopped';
      a.transcript.push({ t: now(), kind: 'system', text: 'Stopped by you.' });
    }
    if (run && run.kill) run.kill();
    if (wasActive && a.parentId && !a.report) this._deliverReport(a, { status: 'stopped', summary: 'Stopped by the human before it finished.', auto: true });
    const w = this.waiters.get(a.id);
    if (w) w.finish();
    for (const item of this.inbox) {
      if (item.agentId === a.id && item.status === 'open' && item.kind !== 'report') this._resolveInbox(item, null, 'Stopped');
    }
    if (cascade) for (const k of this.children(a.id)) if (ACTIVE.has(k.status)) this.stop(k.id);
    this._emit(a.id);
    return this.publicAgent(a);
  }

  setPace(agentId, pace) {
    const a = this.getAgent(agentId);
    if (!PACES.includes(pace)) throw new Error(`Pace is one of ${PACES.join(', ')}`);
    a.pace = pace;
    a.transcript.push({ t: now(), kind: 'system', text: `Pace set to ${pace}${this.modelFor(a) ? ` (${this.modelFor(a)})` : ''}. Takes effect on its next turn.` });
    this._emit(a.id);
    return this.publicAgent(a);
  }

  // Move an agent's work to another provider without re-explaining it:
  // the new session gets the brief plus everything the old one said and did.
  handoff(agentId, provider) {
    const a = this.getAgent(agentId);
    if (!this.providers[provider]) throw new Error(`Unknown provider ${provider}`);
    if (provider === a.provider) return this.publicAgent(a);
    const wasRunning = this.runs.has(a.id);
    const run = this.runs.get(a.id);
    const from = a.provider;
    if (run && run.kill) {
      a._handingOff = true;
      run.kill();
    }
    a.provider = this._resolveProvider(a, provider);
    a.transcript.push({ t: now(), kind: 'system', text: `Handed from ${from} to ${a.provider}. The new session gets the brief and this transcript.` });
    a.queuedMessages = [this._handoffPrompt(a, from)];
    a.report = null;
    a.status = 'queued';
    this._emit(a.id);
    if (!wasRunning) this._schedule();
    return this.publicAgent(a);
  }

  _handoffPrompt(a, from) {
    const lines = a.transcript
      .filter((e) => ['user', 'assistant', 'tool', 'child-report', 'report', 'answer'].includes(e.kind))
      .slice(-60)
      .map((e) => {
        if (e.kind === 'tool') return `[tool ${e.name}] ${clip(e.input, 300)}`;
        if (e.kind === 'child-report') return `[report from ${e.role} ${e.fromId}] ${clip(e.text, 1500)}`;
        return `[${e.kind}${e.from ? ' from ' + e.from : ''}] ${clip(e.text, 1500)}`;
      });
    return [
      `You are taking over this work from a ${from} agent. Its session is closed; you won't be able to ask it anything.`,
      'Here is the original brief, then the record of what happened so far. Continue from where it left off; don\'t redo finished steps unless they look wrong.',
      '',
      '## Original brief',
      a.task,
      '',
      '## So far',
      lines.join('\n'),
    ].join('\n');
  }

  answer(inboxId, answer) {
    const item = this.inbox.find((i) => i.id === inboxId);
    if (!item) throw new Error('No such inbox item');
    if (item.status !== 'open') return item;
    if (item.kind === 'report') {
      item.status = 'read';
      this._emit(item.agentId);
      return item;
    }
    this._resolveInbox(item, answer);
    return item;
  }

  _resolveInbox(item, answer, statusNote) {
    item.status = statusNote ? 'expired' : 'answered';
    item.answeredAt = now();
    item.answer = answer;
    const a = this.agents.get(item.agentId);
    if (a && !statusNote) {
      const text =
        item.kind === 'approval'
          ? `${answer && answer.allow ? 'Allowed' : 'Denied'} ${item.toolName}${answer && answer.always ? ' (always, for this agent)' : ''}${answer && answer.message ? `: ${answer.message}` : ''}`
          : String(answer);
      a.transcript.push({ t: now(), kind: 'answer', text, from: 'you' });
    }
    const resolve = this.inboxWaiters.get(item.id);
    this.inboxWaiters.delete(item.id);
    if (resolve) resolve(answer);
    else if (a && !statusNote && item.deferred && item.kind === 'question') {
      a.queuedMessages.push(`The human answered your question.\nQuestion: ${item.text}\nAnswer: ${answer}`);
      if (!this.runs.has(a.id) && a.status !== 'stopped') a.status = 'queued';
      setImmediate(() => this._schedule());
    }
    if (a) this._emit(a.id);
  }

  dismissInbox(inboxId) {
    const item = this.inbox.find((i) => i.id === inboxId);
    if (item && item.status !== 'open') {
      item.dismissed = true;
      this._emit(item.agentId);
    }
  }

  // ---------- crew tools (called by agents through the bridge) ----------

  async toolCall(agentId, token, name, args = {}) {
    const a = this.agents.get(agentId);
    if (!a || a.token !== token) throw new Error('Unknown agent or bad token.');
    if (a.status === 'stopped') return 'This agent was stopped by the human. End your turn now.';
    switch (name) {
      case 'delegate':
        return this._toolDelegate(a, args);
      case 'wait_for_reports':
        return this._toolWait(a, args);
      case 'report':
        return this._toolReport(a, args);
      case 'ask_human':
        return this._toolAsk(a, args);
      case 'remember':
        return this._toolRemember(a, args);
      case 'list_team':
        return this._toolListTeam(a);
      case 'approve_tool':
        return this._toolApprove(a, args);
      default:
        throw new Error(`Unknown crew tool ${name}`);
    }
  }

  _toolDelegate(a, { role, task, title, provider, pace }) {
    if (this.depth(a) + 1 > this.settings.maxDepth) {
      return `Not delegated: the crew is already ${this.settings.maxDepth} levels deep here. Do this piece yourself.`;
    }
    if (this.children(a.id).length >= this.settings.maxChildren) {
      return `Not delegated: you already have ${this.settings.maxChildren} agents. Wait for reports or do it yourself.`;
    }
    if (!this.roles.get(role)) {
      return `Not delegated: no role "${role}". Roles: ${this.roles.list().map((r) => r.name).join(', ')}.`;
    }
    const child = this.startTask({ role, task, title, provider, pace, parentId: a.id });
    a.transcript.push({ t: now(), kind: 'delegate', text: child.title, childId: child.id, role: child.role, provider: child.provider });
    this._emit(a.id);
    return `Delegated to ${child.role} on ${child.provider} as ${child.id} ("${child.title}"). It will report back to you.`;
  }

  _toolWait(a, { agent_ids, timeout_s }) {
    const ids = Array.isArray(agent_ids) && agent_ids.length ? agent_ids.filter((x) => this.agents.get(x)?.parentId === a.id) : null;
    const cap = Math.max(0.05, Number(this.settings.blockSeconds) || 90);
    const timeout = Math.max(0.05, Math.min(Number(timeout_s) || cap, cap)) * 1000;
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(w.timer);
        this.waiters.delete(a.id);
        a._blocked = false;
        if (a.status === 'waiting') a.status = 'running';
        const want = ids ? new Set(ids) : null;
        const fresh = a.pendingReports.filter((r) => !r.delivered && (!want || want.has(r.fromId)));
        fresh.forEach((r) => (r.delivered = true));
        const still = this.children(a.id).filter((k) => ACTIVE.has(k.status) && !k.report && (!want || want.has(k.id)));
        this._emit(a.id);
        if (!fresh.length && !still.length) return resolve('No reports pending: nothing you delegated is still working.');
        const body = fresh.length ? fresh.map(formatReport).join('\n\n') : 'No new reports yet.';
        resolve(still.length ? `${body}\n\nStill working: ${still.map((k) => `${k.role} (${k.id})`).join(', ')}. Their reports will be delivered to you as a new message, so you can end your turn now, or call wait_for_reports again.` : body);
      };
      const w = { ids, finish, timer: setTimeout(finish, timeout) };
      w.timer.unref?.();
      this.waiters.set(a.id, w);
      a._blocked = true;
      a.status = 'waiting';
      this._emit(a.id);
      this._schedule(); // a slot just opened up
      this._checkWaiter(a.id);
    });
  }

  _toolReport(a, { summary, status }) {
    if (!summary || !String(summary).trim()) return 'Report not sent: summary is empty.';
    const st = ['done', 'blocked', 'failed'].includes(status) ? status : 'done';
    a._reportedThisTurn = true;
    this._setReport(a, { status: st, summary });
    this._emit(a.id);
    return a.parentId
      ? 'Report delivered. End your turn now with a one-line sign-off.'
      : 'Report delivered to the human. End your turn now.';
  }

  _toolAsk(a, { question, options }) {
    const opts = Array.isArray(options) ? options.map(String).filter(Boolean).slice(0, 4) : [];
    const item = { id: id('in'), agentId: a.id, kind: 'question', text: String(question || ''), options: opts, status: 'open', createdAt: now() };
    a.transcript.push({ t: now(), kind: 'question', text: item.text, options: opts, inboxId: item.id });
    const limit = Math.max(0.05, Number(this.settings.blockSeconds) || 90) * 1000;
    return this._waitInbox(a, item, limit).then((answer) => {
      if (answer === TIMEOUT) {
        item.deferred = true; // the answer will wake this agent with a new message
        return 'The human has not answered yet. Their answer will be delivered to you as a new message when they reply. If you need it to continue, end your turn now; otherwise carry on with work that does not depend on it.';
      }
      return answer == null ? 'The human did not answer (the agent was stopped).' : `The human answered: ${answer}`;
    });
  }

  _toolApprove(a, { tool_name, input }) {
    const allow = (inp) => JSON.stringify({ behavior: 'allow', updatedInput: inp || input || {} });
    if (/^mcp__crew__/.test(tool_name || '')) return allow();
    if (a.allowedTools.includes(tool_name)) return allow();
    const item = {
      id: id('in'),
      agentId: a.id,
      kind: 'approval',
      toolName: String(tool_name),
      toolInput: clip(JSON.stringify(input || {}, null, 2), 4000),
      text: describeTool(tool_name, input),
      status: 'open',
      createdAt: now(),
    };
    a.transcript.push({ t: now(), kind: 'approval', text: item.text, name: tool_name, inboxId: item.id });
    return this._waitInbox(a, item).then((ans) => {
      if (ans && ans.allow) {
        if (ans.always && !a.allowedTools.includes(tool_name)) a.allowedTools.push(tool_name);
        return allow();
      }
      return JSON.stringify({ behavior: 'deny', message: (ans && ans.message) || 'The human denied this. Find another way or ask them.' });
    });
  }

  _waitInbox(a, item, limitMs) {
    // Register the waiter before anyone can see the item, so an instant answer isn't lost.
    const result = new Promise((resolve) => {
      let timer = null;
      const settle = (answer) => {
        clearTimeout(timer);
        if (this.inboxWaiters.get(item.id) === settle) this.inboxWaiters.delete(item.id);
        const stillBlocked = this.inbox.some((i) => i.agentId === a.id && i.status === 'open' && i.kind !== 'report' && this.inboxWaiters.has(i.id));
        if (!stillBlocked) {
          a._blocked = false;
          if (a.status === 'asking' && this.runs.has(a.id)) a.status = this.waiters.has(a.id) ? 'waiting' : 'running';
        }
        this._emit(a.id);
        resolve(answer);
      };
      this.inboxWaiters.set(item.id, settle);
      if (limitMs) {
        timer = setTimeout(() => settle(TIMEOUT), limitMs);
        timer.unref?.();
      }
    });
    this.inbox.push(item);
    a.status = 'asking';
    a._blocked = true;
    this._emit(a.id);
    this.emit('notify', { agentId: a.id, kind: item.kind, text: clip(item.text, 200) });
    this._schedule();
    return result;
  }

  _toolRemember(a, { note }) {
    if (!note || !String(note).trim()) return 'Nothing saved: the note is empty.';
    try {
      const line = this.roles.appendMemory(a.role, note);
      a.transcript.push({ t: now(), kind: 'memory', text: line });
      this._emit(a.id);
      return `Saved to the ${a.role} memory.`;
    } catch (e) {
      return `Not saved: ${e.message}`;
    }
  }

  _toolListTeam(a) {
    const roles = this.roles.list().map((r) => `- ${r.name} (${r.provider}, ${r.pace}): ${r.description}`);
    const kids = this.children(a.id).map((k) => `- ${k.id} ${k.role} [${k.status}] "${k.title}"`);
    return `Roles:\n${roles.join('\n')}\n\nYour agents:\n${kids.join('\n') || '(none)'}`;
  }

  // ---------- teams ----------

  applyTeam(team) {
    const roles = (team && team.roles) || [];
    if (!roles.length) throw new Error('The team has no roles.');
    const saved = this.roles.save(roles);
    if (team.pace && PACES.includes(team.pace)) this.updateSettings({ pace: team.pace });
    this._emit();
    return saved;
  }

  shutdown() {
    for (const [agentId, run] of this.runs) {
      const a = this.agents.get(agentId);
      if (a) a.transcript.push({ t: now(), kind: 'system', text: 'The app closed while this agent was working.' });
      try {
        run.kill && run.kill();
      } catch {}
    }
    this.flush();
  }
}

const TIMEOUT = Symbol('timeout');

function formatReport(r) {
  const head = `## Report from ${r.role} (${r.fromId}, ${r.provider}) — "${r.title}" — ${r.status}${r.auto ? ' (its final message; it did not call report)' : ''}`;
  return `${head}\n${r.summary}`;
}

function describeTool(name, input) {
  input = input || {};
  if (name === 'Bash') return `Run a command: ${clip(input.command, 300)}`;
  if (name === 'Write') return `Create or overwrite ${input.file_path}`;
  if (name === 'Edit' || name === 'MultiEdit') return `Edit ${input.file_path}`;
  if (name === 'WebFetch') return `Fetch ${input.url}`;
  if (name === 'WebSearch') return `Search the web: ${clip(input.query, 200)}`;
  return `Use ${name}`;
}

function deepMerge(base, patch) {
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') base[k] = deepMerge(base[k], v);
    else base[k] = v;
  }
  return base;
}

module.exports = { Orchestrator, ACTIVE, DEFAULT_SETTINGS, formatReport };
