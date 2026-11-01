'use strict';
/* global crew, md */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = md.esc;

const ui = {
  state: null,
  selected: null,
  agent: null, // full selected agent, with transcript
  collapsed: new Set(),
  tab: 'needs',
  hideDone: false,
  drafts: {},
};

try {
  ui.hideDone = localStorage.getItem('hideDone') === '1';
  ui.collapsed = new Set(JSON.parse(localStorage.getItem('collapsed') || '[]'));
} catch {}

const ACTIVE = new Set(['queued', 'running', 'waiting', 'asking']);
const STATUS_LABEL = {
  queued: 'Queued',
  running: 'Working',
  waiting: 'Waiting on its crew',
  asking: 'Waiting on you',
  idle: 'Replied',
  done: 'Done',
  blocked: 'Blocked',
  failed: 'Failed',
  stopped: 'Stopped',
};
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex', mock: 'Demo' };

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function money(n) {
  return n ? `$${n < 0.01 ? n.toFixed(4) : n.toFixed(2)}` : '';
}

async function refresh(changed) {
  ui.state = await crew.call('state');
  if (ui.selected && !ui.state.agents.some((a) => a.id === ui.selected)) ui.selected = null;
  if (!ui.selected) {
    const recent = [...ui.state.agents].filter((a) => !a.parentId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
    if (recent) ui.selected = recent.id;
  }
  if (ui.selected && (!changed || !ui.agent || changed.includes(ui.selected) || ui.agent.id !== ui.selected)) {
    ui.agent = await crew.call('agent', ui.selected);
  }
  render();
}

function select(agentId) {
  if (ui.selected === agentId) return;
  saveDraft();
  ui.selected = agentId;
  ui.agent = null;
  refresh([agentId]);
}

function saveDraft() {
  const box = $('#composer-text');
  if (box && ui.agent) ui.drafts[ui.agent.id] = box.value;
}

// ---------- rendering ----------

function render() {
  renderTop();
  renderTree();
  renderDetail();
  renderInbox();
}

function renderTop() {
  const s = ui.state;
  $$('#global-pace button').forEach((b) => b.classList.toggle('on', b.dataset.pace === s.settings.pace));
  const running = s.agents.filter((a) => a.status === 'running').length;
  const cost = s.agents.reduce((n, a) => n + (a.usage?.costUsd || 0), 0);
  const limit = s.settings.concurrency[s.settings.pace];
  $('#meter').textContent = `${running}/${limit} working${cost ? ` · ${money(cost)}` : ''}`;
}

function openItemsFor(agentId) {
  return ui.state.inbox.filter((i) => i.agentId === agentId && i.status === 'open' && i.kind !== 'report').length;
}

function renderTree() {
  const s = ui.state;
  const tree = $('#tree');
  const byParent = new Map();
  for (const a of s.agents) {
    const k = a.parentId || 'root';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(a);
  }
  const roots = (byParent.get('root') || []).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const visibleRoots = ui.hideDone ? roots.filter((r) => subtreeActive(r, byParent) || r.id === ui.selected) : roots;

  if (!roots.length) {
    tree.innerHTML = `<div class="empty-tree">Nothing yet. Start a task and its crew shows up here as a tree.</div>`;
    return;
  }
  const row = (a, depth) => {
    const kids = (byParent.get(a.id) || []).sort((x, y) => x.createdAt.localeCompare(y.createdAt));
    const open = openItemsFor(a.id);
    const collapsed = ui.collapsed.has(a.id);
    let html = `<div class="node d-${Math.min(depth, 6)} ${a.id === ui.selected ? 'sel' : ''}" role="treeitem" data-id="${a.id}" aria-level="${depth + 1}">
      ${kids.length ? `<button class="twisty" data-twisty="${a.id}" aria-label="${collapsed ? 'Expand' : 'Collapse'}">${collapsed ? '▸' : '▾'}</button>` : '<span class="twisty-sp"></span>'}
      <span class="dot s-${a.status}" title="${STATUS_LABEL[a.status] || a.status}"></span>
      <span class="node-main">
        <span class="node-title">${esc(a.title)}</span>
        <span class="node-meta"><span class="role">${esc(a.role)}</span><span class="prov p-${a.provider}">${PROVIDER_LABEL[a.provider] || a.provider}</span>${kids.length ? `<span class="kids">${kids.filter((k) => !ACTIVE.has(k.status)).length}/${kids.length}</span>` : ''}</span>
      </span>
      ${open ? `<span class="badge" title="Waiting on you">${open}</span>` : ''}
    </div>`;
    if (kids.length && !collapsed) {
      const shown = ui.hideDone ? kids.filter((k) => subtreeActive(k, byParent) || k.id === ui.selected) : kids;
      html += shown.map((k) => row(k, depth + 1)).join('');
    }
    return html;
  };
  tree.innerHTML = visibleRoots.map((r) => `<div class="root-group">${row(r, 0)}</div>`).join('') || `<div class="empty-tree">Everything is finished. Untick "Hide finished" to see it.</div>`;
}

function subtreeActive(a, byParent) {
  if (ACTIVE.has(a.status) || openItemsFor(a.id)) return true;
  return (byParent.get(a.id) || []).some((k) => subtreeActive(k, byParent));
}

function renderDetail() {
  const el = $('#detail');
  const a = ui.agent;
  if (!a) {
    el.innerHTML = welcome();
    el.dataset.agent = '';
    return;
  }
  const s = ui.state;
  const parent = a.parentId && s.agents.find((x) => x.id === a.parentId);
  const otherProvider = a.provider === 'codex' ? 'claude' : 'codex';
  const otherOk = s.providers[otherProvider]?.available;
  const active = ACTIVE.has(a.status);
  const model = s.settings.models?.[a.provider]?.[a.pace];

  const keepScroll = $('#transcript');
  const atBottom = !keepScroll || keepScroll.scrollHeight - keepScroll.scrollTop - keepScroll.clientHeight < 40;
  const prevTop = keepScroll ? keepScroll.scrollTop : 0;
  const draft = $('#composer-text') ? $('#composer-text').value : ui.drafts[a.id] || '';
  const hadFocus = document.activeElement && document.activeElement.id === 'composer-text';
  const sameAgent = el.dataset.agent === a.id;
  const openTools = sameAgent ? new Set($$('#transcript details[open]').map((d) => d.dataset.i)) : new Set();
  el.dataset.agent = a.id;

  el.innerHTML = `
    <div class="detail-head">
      <div class="crumbs">${parent ? `<a href="#" data-goto="${parent.id}">↑ ${esc(parent.role)}: ${esc(parent.title)}</a>` : '<span>Started by you</span>'}</div>
      <h1>${esc(a.title)}</h1>
      <div class="facts">
        <span class="pill s-${a.status}">${STATUS_LABEL[a.status] || a.status}</span>
        <span class="role">${esc(a.role)}</span>
        <span class="prov p-${a.provider}">${PROVIDER_LABEL[a.provider] || a.provider}${model ? ` · ${esc(model)}` : ''}</span>
        <span class="muted" title="${esc(a.cwd)}">${esc(shortPath(a.cwd))}</span>
        ${a.usage?.costUsd ? `<span class="muted">${money(a.usage.costUsd)}</span>` : ''}
        ${a.queued ? `<span class="muted">${a.queued} message(s) queued</span>` : ''}
      </div>
      <div class="actions">
        <label class="mini">Pace
          <select id="agent-pace">${['thrifty', 'balanced', 'max'].map((p) => `<option value="${p}" ${p === a.pace ? 'selected' : ''}>${p[0].toUpperCase() + p.slice(1)}</option>`).join('')}</select>
        </label>
        ${a.provider !== 'mock' ? `<button id="agent-handoff" ${otherOk ? '' : 'disabled'} title="${otherOk ? `Move this work to ${PROVIDER_LABEL[otherProvider]}, with its brief and transcript` : `${PROVIDER_LABEL[otherProvider]} isn't installed`}">Hand to ${PROVIDER_LABEL[otherProvider]}</button>` : ''}
        <button id="agent-memory" title="What every ${esc(a.role)} agent remembers">${esc(a.role)} memory</button>
        ${active ? '<button id="agent-stop" class="danger">Stop</button>' : ''}
      </div>
    </div>
    <div class="transcript" id="transcript">${a.transcript.map((e, i) => entry(e, i, a)).join('')}${active && a.status === 'running' ? '<div class="typing"><span></span><span></span><span></span></div>' : ''}</div>
    <form class="composer" id="composer">
      <textarea id="composer-text" rows="2" placeholder="Talk to this ${esc(a.role)} directly${active ? ' (delivered after its current step)' : ''}…  Ctrl+Enter to send"></textarea>
      <button class="primary" type="submit">Send</button>
    </form>`;

  const t = $('#transcript');
  $$('details[data-i]', t).forEach((d) => openTools.has(d.dataset.i) && (d.open = true));
  t.scrollTop = !sameAgent || atBottom ? t.scrollHeight : prevTop;
  const box = $('#composer-text');
  box.value = draft;
  if (hadFocus) box.focus();
}

function shortPath(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
}

function entry(e, i, a) {
  const time = `<time title="${esc(e.t)}">${new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>`;
  switch (e.kind) {
    case 'user':
      return `<div class="msg user"><div class="who">${esc(e.from === 'you' || !e.from ? 'You' : e.from)} ${time}</div><div class="bubble">${md.render(e.text)}</div></div>`;
    case 'assistant':
      return `<div class="msg agent"><div class="who">${esc(a.role)} ${time}</div><div class="bubble">${md.render(e.text)}</div></div>`;
    case 'tool':
      return `<details class="tool" data-i="${i}"><summary><span class="tname">${esc(e.name || 'tool')}</span> <span class="targ">${esc(toolArg(e))}</span></summary>${e.input ? `<pre>${esc(e.input)}</pre>` : ''}${e.text ? `<pre class="out">${esc(e.text)}</pre>` : ''}</details>`;
    case 'delegate':
      return `<div class="card delegate"><span class="label">Delegated to ${esc(e.role)} · ${PROVIDER_LABEL[e.provider] || e.provider}</span><a href="#" data-goto="${e.childId}">${esc(e.text)}</a> ${time}</div>`;
    case 'child-report':
      return `<div class="card report r-${esc(e.status)}"><span class="label">Report from <a href="#" data-goto="${e.fromId}">${esc(e.role)}</a> · ${esc(e.status)}${e.auto ? ' · its final message' : ''} ${time}</span><div class="body">${md.render(e.text)}</div></div>`;
    case 'report':
      return `<div class="card report mine r-${esc(e.status)}"><span class="label">${a.parentId ? 'Reported back' : 'Reported to you'} · ${esc(e.status)}${e.auto ? ' · its final message' : ''} ${time}</span><div class="body">${md.render(e.text)}</div></div>`;
    case 'question':
      return `<div class="card ask"><span class="label">Asked you ${time}</span><div class="body">${md.render(e.text)}</div>${e.options?.length ? `<div class="opts muted">${e.options.map(esc).join(' · ')}</div>` : ''}</div>`;
    case 'approval':
      return `<div class="card ask"><span class="label">Asked permission ${time}</span><div class="body">${esc(e.text)}</div></div>`;
    case 'answer':
      return `<div class="card answer"><span class="label">You answered ${time}</span><div class="body">${esc(e.text)}</div></div>`;
    case 'memory':
      return `<div class="note">Saved to ${esc(a.role)} memory: ${esc(e.text)}</div>`;
    case 'error':
      return `<div class="note error">${esc(e.text)}</div>`;
    default:
      return `<div class="note">${esc(e.text)}</div>`;
  }
}

function toolArg(e) {
  if (!e.input) return '';
  try {
    const o = JSON.parse(e.input);
    return o.command || o.file_path || o.path || o.pattern || o.query || o.url || o.description || Object.values(o).find((v) => typeof v === 'string') || '';
  } catch {
    return String(e.input).split('\n')[0];
  }
}

function welcome() {
  const s = ui.state;
  const have = Object.entries(s.providers).filter(([k, v]) => v.available && k !== 'mock').map(([k]) => PROVIDER_LABEL[k]);
  return `<div class="welcome">
    <h1>Your crew delegates. You answer questions.</h1>
    <p>Give a task to the lead. It splits the work and hands pieces to other agents, real Claude Code and Codex sessions underneath. They report back up the tree. When one needs you, it lands in the inbox on the right.</p>
    <ul>
      <li><b>Tree</b>: every agent, who gave it the work, and where it stands.</li>
      <li><b>Inbox</b>: every question and permission prompt, from every agent, in one place.</li>
      <li><b>Talk to anyone</b>: click any agent and message it directly.</li>
      <li><b>Pace</b>: slow down to save usage, or speed up. Hand any agent to Codex or Claude without re-explaining.</li>
    </ul>
    <p class="muted">${have.length ? `Found on this computer: ${have.join(' and ')}.` : 'Neither Claude Code nor Codex was found on your PATH. Install one, or try the demo crew (no AI, no cost).'}</p>
    <div class="welcome-actions">
      <button class="primary" id="welcome-new">New task</button>
      <button id="welcome-demo">Try the demo crew</button>
    </div>
  </div>`;
}

function renderInbox() {
  const s = ui.state;
  const needs = s.inbox.filter((i) => i.status === 'open' && i.kind !== 'report');
  const reports = s.inbox.filter((i) => i.kind === 'report' && !i.dismissed).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const unread = reports.filter((r) => r.status === 'open').length;
  $('#needs-count').textContent = needs.length || '';
  $('#reports-count').textContent = unread || '';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === ui.tab));
  document.title = needs.length ? `(${needs.length}) Puffin Crew` : 'Puffin Crew';

  const el = $('#inbox');
  // Don't clobber an answer someone is typing.
  const typing = document.activeElement && el.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
  const drafts = {};
  $$('input[data-answer-text]', el).forEach((inp) => (drafts[inp.dataset.answerText] = inp.value));
  if (typing && ui._inboxKey === inboxKey(needs, reports)) return;
  ui._inboxKey = inboxKey(needs, reports);
  const focusedId = typing ? document.activeElement.dataset.answerText : null;

  const agentOf = (id) => s.agents.find((a) => a.id === id) || { role: '?', title: '' };
  const from = (item) => {
    const a = agentOf(item.agentId);
    return `<a href="#" class="from" data-goto="${a.id}"><span class="role">${esc(a.role)}</span> ${esc(a.title)}</a><time>${ago(item.createdAt)}</time>`;
  };

  if (ui.tab === 'needs') {
    el.innerHTML = needs.length
      ? needs
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((i) =>
            i.kind === 'approval'
              ? `<div class="item approval" data-item="${i.id}">
              <div class="item-head">${from(i)}</div>
              <div class="item-kind">Permission</div>
              <div class="item-text">${esc(i.text)}</div>
              <details><summary>Details</summary><pre>${esc(i.toolInput || '')}</pre></details>
              <div class="item-actions">
                <button class="primary" data-allow="${i.id}">Allow</button>
                <button data-allow-always="${i.id}" title="Don't ask again for ${esc(i.toolName)} from this agent">Always for this agent</button>
                <button class="danger" data-deny="${i.id}">Deny</button>
              </div></div>`
              : `<div class="item question" data-item="${i.id}">
              <div class="item-head">${from(i)}</div>
              <div class="item-text">${md.render(i.text)}</div>
              ${i.options?.length ? `<div class="item-actions opts">${i.options.map((o, n) => `<button data-option="${i.id}" data-n="${n}">${esc(o)}</button>`).join('')}</div>` : ''}
              <form class="answer-form" data-answer="${i.id}"><input data-answer-text="${i.id}" placeholder="${i.options?.length ? 'Or type an answer…' : 'Type your answer…'}" /><button type="submit">Send</button></form>
            </div>`
          )
          .join('')
      : `<div class="empty-inbox"><div class="big">Nothing needs you.</div><div>Questions and permission prompts from every agent show up here.</div></div>`;
  } else {
    el.innerHTML = reports.length
      ? reports
          .map(
            (r) => `<div class="item report ${r.status === 'open' ? 'unread' : ''} r-${esc(r.reportStatus || 'done')}" data-item="${r.id}">
          <div class="item-head">${from(r)}</div>
          <div class="item-text">${md.render(r.text || '(no text)')}</div>
          <div class="item-actions">${r.status === 'open' ? `<button data-read="${r.id}">Mark read</button>` : `<button data-dismiss="${r.id}">Clear</button>`}</div>
        </div>`
          )
          .join('')
      : `<div class="empty-inbox"><div class="big">No reports yet.</div><div>When a task you started finishes, its report lands here.</div></div>`;
  }
  for (const [k, v] of Object.entries(drafts)) {
    const inp = $(`input[data-answer-text="${k}"]`, el);
    if (inp) inp.value = v;
  }
  if (focusedId) $(`input[data-answer-text="${focusedId}"]`, el)?.focus();
}

function inboxKey(needs, reports) {
  return ui.tab + needs.map((n) => n.id).join() + '|' + reports.map((r) => r.id + r.status).join();
}

// ---------- events ----------

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, .node');
  if (!t) return;
  const d = t.dataset;

  if (d.twisty) {
    e.stopPropagation();
    ui.collapsed.has(d.twisty) ? ui.collapsed.delete(d.twisty) : ui.collapsed.add(d.twisty);
    try {
      localStorage.setItem('collapsed', JSON.stringify([...ui.collapsed]));
    } catch {}
    renderTree();
    return;
  }
  if (d.goto) {
    e.preventDefault();
    select(d.goto);
    return;
  }
  if (t.classList.contains('node')) return select(d.id);
  if (d.tab) {
    ui.tab = d.tab;
    ui._inboxKey = null;
    renderInbox();
    return;
  }
  if (d.option) return crew.call('answer', d.option, ui.state.inbox.find((i) => i.id === d.option).options[Number(d.n)]);
  if (d.allow) return crew.call('answer', d.allow, { allow: true });
  if (d.allowAlways) return crew.call('answer', d.allowAlways, { allow: true, always: true });
  if (d.deny) {
    const card = t.closest('.item');
    const reason = $('input', card)?.value;
    return crew.call('answer', d.deny, { allow: false, message: reason || undefined });
  }
  if (d.read) return crew.call('answer', d.read, null);
  if (d.dismiss) return crew.call('dismiss', d.dismiss);
  if (d.pace && t.closest('#global-pace')) return crew.call('updateSettings', { pace: d.pace });

  switch (t.id) {
    case 'btn-new':
    case 'welcome-new':
      return openNew();
    case 'welcome-demo':
      return startDemo();
    case 'btn-team':
      return openTeam();
    case 'btn-settings':
      return openSettings();
    case 'agent-stop':
      return crew.call('stop', ui.agent.id);
    case 'agent-handoff':
      return crew.call('handoff', ui.agent.id, ui.agent.provider === 'codex' ? 'claude' : 'codex');
    case 'agent-memory':
      return openMemory(ui.agent.role);
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'agent-pace') crew.call('setPace', ui.agent.id, e.target.value);
  if (e.target.id === 'hide-done') {
    ui.hideDone = e.target.checked;
    try {
      localStorage.setItem('hideDone', ui.hideDone ? '1' : '0');
    } catch {}
    renderTree();
  }
});

document.addEventListener('submit', (e) => {
  if (e.target.id === 'composer') {
    e.preventDefault();
    sendComposer();
  } else if (e.target.dataset.answer) {
    e.preventDefault();
    const inp = $('input', e.target);
    if (inp.value.trim()) crew.call('answer', e.target.dataset.answer, inp.value.trim());
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'composer-text' && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendComposer();
  }
});

function sendComposer() {
  const box = $('#composer-text');
  const text = box.value.trim();
  if (!text || !ui.agent) return;
  box.value = '';
  ui.drafts[ui.agent.id] = '';
  crew.call('sendMessage', ui.agent.id, text);
}

// ---------- dialogs ----------

function providerOptions(selected) {
  return Object.entries(ui.state.providers)
    .map(([k, v]) => `<option value="${k}" ${k === selected ? 'selected' : ''} ${v.available ? '' : 'disabled'}>${PROVIDER_LABEL[k] || k}${v.available ? '' : ' (not installed)'}</option>`)
    .join('');
}

function openNew(prefill = {}) {
  const dlg = $('#dlg-new');
  const f = $('#form-new');
  f.role.innerHTML = ui.state.roles.map((r) => `<option value="${esc(r.name)}" ${r.name === (prefill.role || 'lead') ? 'selected' : ''}>${esc(r.name)}${r.source === 'crew' ? ' (puffin)' : ''}</option>`).join('');
  const syncProvider = () => {
    const role = ui.state.roles.find((r) => r.name === f.role.value);
    const want = role?.provider || 'claude';
    const ok = ui.state.providers[want]?.available;
    f.provider.innerHTML = `<option value="">Role default (${PROVIDER_LABEL[want] || want}${ok ? '' : ', not installed'})</option>` + providerOptions('');
  };
  syncProvider();
  f.role.onchange = syncProvider;
  f.task.value = prefill.task || '';
  f.cwd.value = prefill.cwd || ui.state.settings.defaultCwd || '';
  $('#pick-folder').onclick = async () => {
    const p = await crew.call('pickFolder');
    if (p) f.cwd.value = p;
  };
  dlg.returnValue = '';
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    try {
      const a = await crew.call('startTask', { role: f.role.value, task: f.task.value, provider: f.provider.value || undefined, pace: f.pace.value || undefined, cwd: f.cwd.value || undefined });
      ui.selected = a.id;
      ui.agent = null;
      refresh([a.id]);
    } catch (err) {
      alert(err.message);
    }
  };
}

async function startDemo() {
  const a = await crew.call('startTask', {
    role: 'lead',
    provider: 'mock',
    title: 'Demo: ship the settings page',
    task: 'Build the settings page\nAsk about the colour scheme and write the form validation\nReview the settings tests',
  });
  ui.selected = a.id;
  ui.agent = null;
  refresh([a.id]);
}

let teamDraft = [];
let teamPace = null; // suggested by Design team; applied only on Save

function openTeam() {
  teamDraft = ui.state.roles.map((r) => ({ ...r }));
  teamPace = null;
  $('#team-note').textContent = '';
  renderTeamRoles();
  const dlg = $('#dlg-team');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue !== 'ok') return;
    readTeamRoles();
    await crew.call('saveRoles', teamDraft);
    if (teamPace) await crew.call('updateSettings', { pace: teamPace });
    refresh();
  };
}

function renderTeamRoles() {
  $('#team-roles').innerHTML = teamDraft
    .map(
      (r, i) => `<div class="role-card ${r.source === 'crew' ? 'crew' : ''}" data-i="${i}">
      <div class="row">
        <label>Name <input data-f="name" value="${esc(r.name)}" ${r.source === 'crew' || r.name === 'lead' ? 'readonly' : ''} /></label>
        <label>Runs on <select data-f="provider" ${r.source === 'crew' ? 'disabled' : ''}>${['claude', 'codex', 'mock'].map((p) => `<option value="${p}" ${p === r.provider ? 'selected' : ''}>${PROVIDER_LABEL[p]}</option>`).join('')}</select></label>
        <label>Pace <select data-f="pace" ${r.source === 'crew' ? 'disabled' : ''}>${['thrifty', 'balanced', 'max'].map((p) => `<option value="${p}" ${p === r.pace ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
        <button type="button" data-mem="${esc(r.name)}">Memory</button>
        ${r.source === 'crew' || r.name === 'lead' ? '' : `<button type="button" class="danger" data-remove="${i}" title="Remove this role">✕</button>`}
      </div>
      <label>What it does <input data-f="description" value="${esc(r.description)}" ${r.source === 'crew' ? 'readonly' : ''} /></label>
      ${r.source === 'crew' ? '<p class="hint">Puffin Crew bot, read from the repo. Its persona and memory are edited there, not here.</p>' : `<label>Standing instructions <textarea data-f="instructions" rows="3">${esc(r.instructions)}</textarea></label>`}
    </div>`
    )
    .join('');
  $$('#team-roles [data-remove]').forEach((b) =>
    (b.onclick = () => {
      readTeamRoles();
      teamDraft.splice(Number(b.dataset.remove), 1);
      renderTeamRoles();
    })
  );
  $$('#team-roles [data-mem]').forEach((b) => (b.onclick = () => openMemory(b.dataset.mem)));
}

function readTeamRoles() {
  $$('#team-roles .role-card').forEach((card) => {
    const r = teamDraft[Number(card.dataset.i)];
    $$('[data-f]', card).forEach((inp) => {
      if (!inp.readOnly && !inp.disabled) r[inp.dataset.f] = inp.value;
    });
  });
}

$('#team-add').onclick = () => {
  readTeamRoles();
  teamDraft.push({ name: 'new-role', description: '', provider: 'claude', pace: 'balanced', instructions: '' });
  renderTeamRoles();
};

$('#team-design').onclick = async () => {
  const text = $('#team-text').value.trim();
  if (!text) return;
  const btn = $('#team-design');
  btn.disabled = true;
  btn.textContent = 'Designing…';
  try {
    const team = await crew.call('designTeam', text);
    const crewRoles = ui.state.roles.filter((r) => r.source === 'crew');
    teamDraft = team.roles.concat(crewRoles);
    $('#team-note').textContent = `${team.source === 'claude' ? 'Designed by Claude.' : 'Read from your description by keywords.'} ${team.note || ''} Suggested pace: ${team.pace} (applied when you save). Edit anything, then Save team.`;
    teamPace = team.pace || null;
    renderTeamRoles();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Design team';
  }
};

async function openMemory(role) {
  const r = ui.state.roles.find((x) => x.name === role);
  const dlg = $('#dlg-memory');
  $('#memory-title').textContent = `${role} memory`;
  const text = await crew.call('readMemory', role);
  const box = $('#memory-text');
  box.value = text;
  box.readOnly = !!r?.memoryReadOnly;
  $('#memory-save').hidden = !!r?.memoryReadOnly;
  $('#memory-hint').textContent = r?.memoryReadOnly
    ? 'This Puffin Crew bot\'s memory is level-gated in the repo, so it is read-only here.'
    : 'Every agent with this role reads this, in every project. Agents add to it with the remember tool.';
  dlg.returnValue = '';
  dlg.showModal();
  dlg.onclose = async () => {
    if (dlg.returnValue === 'ok' && !r?.memoryReadOnly) await crew.call('writeMemory', role, box.value);
  };
}

function openSettings() {
  const s = ui.state.settings;
  const f = $('#form-settings');
  f.permissionMode.value = s.permissionMode;
  for (const p of ['thrifty', 'balanced', 'max']) {
    f[`m.claude.${p}`].value = s.models.claude[p] || '';
    f[`m.codex.${p}`].value = s.models.codex[p] || '';
    f[`c.${p}`].value = s.concurrency[p];
  }
  f.defaultCwd.value = s.defaultCwd || '';
  f.claudePath.value = s.claudePath || '';
  f.codexPath.value = s.codexPath || '';
  $('#settings-where').textContent = `Crew data: ${ui.state.dataDir}${ui.state.crewDir ? ` · Puffins from: ${ui.state.crewDir}` : ''}. Command changes apply after a restart.`;
  const dlg = $('#dlg-settings');
  dlg.returnValue = '';
  dlg.showModal();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'ok') return;
    const patch = { permissionMode: f.permissionMode.value, models: { claude: {}, codex: {} }, concurrency: {}, defaultCwd: f.defaultCwd.value.trim(), claudePath: f.claudePath.value.trim(), codexPath: f.codexPath.value.trim() };
    for (const p of ['thrifty', 'balanced', 'max']) {
      patch.models.claude[p] = f[`m.claude.${p}`].value.trim();
      patch.models.codex[p] = f[`m.codex.${p}`].value.trim();
      patch.concurrency[p] = Math.max(1, Math.min(32, Number(f[`c.${p}`].value) || 1));
    }
    crew.call('updateSettings', patch);
  };
}

// ---------- boot ----------

$('#hide-done').checked = ui.hideDone;
crew.onUpdate(({ changed }) => refresh(changed));
crew.onFocus(({ agentId }) => agentId && select(agentId));
setInterval(() => ui.state && renderInbox(), 30000); // keep "5m ago" fresh
refresh();
