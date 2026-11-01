'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Orchestrator } = require('../src/orchestrator');
const { createMockProvider } = require('../src/providers/mock');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-'));
}

function make(extra = {}) {
  const dataDir = tmp();
  const orch = new Orchestrator({
    dataDir,
    providers: { mock: createMockProvider(), ...(extra.providers || {}) },
    settings: { mockDelayMs: 5, ...(extra.settings || {}) },
    crewDir: extra.crewDir,
  });
  // Every default role runs on the mock in tests.
  orch.roles.save(orch.roles.list().map((r) => ({ ...r, provider: 'mock' })));
  return { orch, dataDir };
}

function until(orch, pred, ms = 4000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (pred()) {
        orch.off('update', check);
        clearTimeout(t);
        resolve();
      }
    };
    const t = setTimeout(() => {
      orch.off('update', check);
      reject(new Error('timed out waiting'));
    }, ms);
    orch.on('update', check);
    check();
  });
}

const openQuestion = (orch) => orch.inbox.find((i) => i.kind === 'question' && i.status === 'open');

test('lead delegates, children report back verbatim, lead asks you, then reports', async () => {
  const { orch } = make();
  const lead = orch.startTask({ role: 'lead', task: 'build the login page and review the login tests' });
  await until(orch, () => openQuestion(orch));

  const kids = orch.children(lead.id);
  assert.equal(kids.length, 2);
  assert.deepEqual(kids.map((k) => k.role).sort(), ['developer', 'reviewer']);
  assert.ok(kids.every((k) => k.status === 'done' && k.report.status === 'done'));

  // Reports reached the lead word for word (deliver-first).
  const leadAgent = orch.getAgent(lead.id);
  for (const k of kids) {
    const delivered = leadAgent.pendingReports.find((r) => r.fromId === k.id);
    assert.equal(delivered.summary, k.report.summary);
    assert.equal(delivered.delivered, true);
  }
  assert.equal(leadAgent.status, 'asking');

  orch.answer(openQuestion(orch).id, 'Wrap up');
  await until(orch, () => orch.getAgent(lead.id).status === 'done');
  const report = orch.inbox.find((i) => i.kind === 'report' && i.agentId === lead.id);
  assert.match(report.text, /2 piece\(s\) delegated/);
  assert.match(report.text, /Wrap up/);
  // The lead's remember() call landed in its role memory.
  assert.match(orch.roles.readMemory('lead'), /check-in before wrap-up/);
});

test('answering "Add a review pass" spawns a reviewer and waits for it', async () => {
  const { orch } = make();
  const lead = orch.startTask({ role: 'lead', task: 'write the docs' });
  await until(orch, () => openQuestion(orch));
  orch.answer(openQuestion(orch).id, 'Add a review pass');
  await until(orch, () => orch.getAgent(lead.id).status === 'done');
  const roles = orch.children(lead.id).map((k) => k.role);
  assert.deepEqual(roles.sort(), ['developer', 'reviewer']);
});

test('a worker question shows up in the inbox and blocks until answered', async () => {
  const { orch } = make();
  const w = orch.startTask({ role: 'developer', task: 'ask about the colour scheme' });
  await until(orch, () => openQuestion(orch));
  assert.equal(orch.getAgent(w.id).status, 'asking');
  assert.deepEqual(openQuestion(orch).options, ['Yes', 'No, do it properly']);
  orch.answer(openQuestion(orch).id, 'Yes');
  await until(orch, () => orch.getAgent(w.id).status === 'done');
  assert.match(orch.getAgent(w.id).report.summary, /The human answered: Yes/);
});

test('stop cascades to children and tells the parent', async () => {
  const { orch } = make();
  const lead = orch.startTask({ role: 'lead', task: 'ask one thing and ask another' });
  await until(orch, () => orch.children(lead.id).length === 2 && openQuestion(orch));
  orch.stop(lead.id);
  const all = [orch.getAgent(lead.id), ...orch.children(lead.id)];
  assert.ok(all.every((a) => ['stopped', 'done'].includes(a.status)), all.map((a) => a.status).join());
  assert.ok(!orch.inbox.some((i) => i.status === 'open' && i.kind !== 'report'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(orch.runs.size, 0);
});

test('a child that ends without calling report reports its last message', async () => {
  const quiet = {
    available: () => true,
    run(ctx) {
      return {
        done: (async () => {
          ctx.onSession('q1');
          ctx.onEvent({ kind: 'assistant', text: 'All done, here is the answer: 42' });
          ctx.onEvent({ kind: 'result', text: 'All done, here is the answer: 42', usage: { costUsd: 0.01 } });
          return {};
        })(),
        kill() {},
      };
    },
  };
  const { orch } = make({ providers: { quiet } });
  const parent = orch.startTask({ role: 'lead', task: 'parent', provider: 'quiet' });
  await until(orch, () => orch.getAgent(parent.id).status === 'idle');
  const child = orch.startTask({ role: 'developer', task: 'child', provider: 'quiet', parentId: parent.id });
  await until(orch, () => orch.getAgent(child.id).status === 'done');
  assert.equal(orch.getAgent(child.id).report.summary, 'All done, here is the answer: 42');
  assert.equal(orch.getAgent(child.id).report.auto, true);
  assert.equal(orch.getAgent(child.id).usage.costUsd, 0.01);
  // The idle parent was woken with the report.
  await until(orch, () => orch.getAgent(parent.id).pendingReports.every((r) => r.delivered) && orch.getAgent(parent.id).status !== 'queued' && !orch.runs.has(parent.id));
  assert.ok(orch.getAgent(parent.id).transcript.some((e) => e.kind === 'child-report'));
});

test('permission prompts become inbox approvals; "always" remembers per agent', async () => {
  let calls = [];
  const asker = {
    available: () => true,
    run(ctx) {
      return {
        done: (async () => {
          const r1 = await ctx.callTool('approve_tool', { tool_name: 'Bash', input: { command: 'npm test' } });
          const r2 = await ctx.callTool('approve_tool', { tool_name: 'Bash', input: { command: 'npm run lint' } });
          const r3 = await ctx.callTool('approve_tool', { tool_name: 'Write', input: { file_path: '/x' } });
          calls = [r1, r2, r3].map((x) => JSON.parse(x));
          return {};
        })(),
        kill() {},
      };
    },
  };
  const { orch } = make({ providers: { asker } });
  const a = orch.startTask({ role: 'developer', task: 'x', provider: 'asker' });
  const openApproval = () => orch.inbox.find((i) => i.kind === 'approval' && i.status === 'open');
  await until(orch, openApproval);
  assert.equal(openApproval().text, 'Run a command: npm test');
  orch.answer(openApproval().id, { allow: true, always: true });
  await until(orch, () => openApproval() && openApproval().toolName === 'Write');
  orch.answer(openApproval().id, { allow: false, message: 'Not there' });
  await until(orch, () => calls.length === 3);
  assert.equal(calls[0].behavior, 'allow');
  assert.deepEqual(calls[0].updatedInput, { command: 'npm test' });
  assert.equal(calls[1].behavior, 'allow'); // remembered, no second prompt
  assert.deepEqual(calls[2], { behavior: 'deny', message: 'Not there' });
  assert.equal(orch.inbox.filter((i) => i.kind === 'approval').length, 2);
  assert.deepEqual(orch.getAgent(a.id).allowedTools, ['Bash']);
});

test('handoff moves work to another provider with the brief and transcript', async () => {
  const prompts = [];
  const recorder = (name) => ({
    available: () => true,
    run(ctx) {
      prompts.push({ name, prompt: ctx.prompt, resume: ctx.resume });
      return {
        done: (async () => {
          ctx.onSession(`${name}-session`);
          ctx.onEvent({ kind: 'assistant', text: `${name} did step one` });
          return {};
        })(),
        kill() {},
      };
    },
  });
  const { orch } = make({ providers: { claude: recorder('claude'), codex: recorder('codex') } });
  const a = orch.startTask({ role: 'lead', task: 'Refactor the parser', provider: 'claude' });
  await until(orch, () => orch.getAgent(a.id).status === 'idle');
  orch.handoff(a.id, 'codex');
  await until(orch, () => prompts.length === 2 && orch.getAgent(a.id).status === 'idle');
  assert.equal(prompts[1].name, 'codex');
  assert.equal(prompts[1].resume, null, 'must not resume a Claude session in Codex');
  assert.match(prompts[1].prompt, /taking over this work from a claude agent/);
  assert.match(prompts[1].prompt, /Refactor the parser/);
  assert.match(prompts[1].prompt, /claude did step one/);
  // Talking to it again resumes the Codex session.
  orch.sendMessage(a.id, 'and add tests');
  await until(orch, () => prompts.length === 3);
  assert.equal(prompts[2].resume, 'codex-session');
});

test('pace limits how many agents run at once, and waiting agents free their slot', async () => {
  let running = 0;
  let peak = 0;
  const slow = {
    available: () => true,
    run(ctx) {
      running++;
      peak = Math.max(peak, running);
      return {
        done: new Promise((r) => setTimeout(() => {
          running--;
          r({});
        }, 30)),
        kill() {},
      };
    },
  };
  const { orch } = make({ providers: { slow }, settings: { pace: 'thrifty', concurrency: { thrifty: 2 } } });
  const ids = [1, 2, 3, 4, 5].map((n) => orch.startTask({ role: 'developer', task: `t${n}`, provider: 'slow' }).id);
  await until(orch, () => ids.every((i) => orch.getAgent(i).status === 'idle'));
  assert.equal(peak, 2);

  // With a limit of 1, a lead waiting on its child must not starve the child.
  const { orch: o2 } = make({ settings: { pace: 'thrifty', concurrency: { thrifty: 1 } } });
  const lead = o2.startTask({ role: 'lead', task: 'one thing' });
  await until(o2, () => openQuestion(o2));
  assert.equal(o2.children(lead.id)[0].status, 'done');
});

test('delegation depth and unknown roles are refused politely', async () => {
  const { orch } = make({ settings: { maxDepth: 1 } });
  const root = orch.startTask({ role: 'developer', task: 'x', provider: 'mock' });
  const a = orch.getAgent(root.id);
  const r1 = await orch.toolCall(a.id, a.token, 'delegate', { role: 'nope', task: 'y' });
  assert.match(r1, /no role "nope"/);
  const ok = await orch.toolCall(a.id, a.token, 'delegate', { role: 'developer', task: 'y' });
  assert.match(ok, /Delegated to developer/);
  const child = orch.children(a.id)[0];
  const r2 = await orch.toolCall(child.id, child.token, 'delegate', { role: 'developer', task: 'z' });
  assert.match(r2, /levels deep/);
  await assert.rejects(orch.toolCall(a.id, 'wrong-token', 'report', { summary: 'x' }), /bad token/);
});

test('state survives a restart; in-flight agents come back stopped', async () => {
  const { orch, dataDir } = make();
  const w = orch.startTask({ role: 'developer', task: 'ask me something' });
  await until(orch, () => openQuestion(orch));
  orch.flush();
  const again = new Orchestrator({ dataDir, providers: { mock: createMockProvider() }, settings: { mockDelayMs: 5 } });
  const a = again.getAgent(w.id);
  assert.equal(a.status, 'stopped');
  assert.equal(again.inbox.find((i) => i.kind === 'question').status, 'expired');
  assert.ok(!('token' in again.publicAgent(a)));
  orch.stop(w.id);
});

test('crew bots load as read-only roles', async () => {
  const crewDir = tmp();
  fs.mkdirSync(path.join(crewDir, 'ledge'));
  fs.writeFileSync(path.join(crewDir, 'ledge', 'persona.md'), '# Ledge\n\nAtlantic puffin, keeps the ledger.\n');
  fs.writeFileSync(path.join(crewDir, 'ledge', 'memory.md'), '- likes short briefs\n');
  const { orch } = make({ crewDir });
  const ledge = orch.roles.get('ledge');
  assert.equal(ledge.source, 'crew');
  assert.match(ledge.description, /Atlantic puffin/);
  assert.match(orch.roles.readMemory('ledge'), /short briefs/);
  assert.throws(() => orch.roles.appendMemory('ledge', 'x'), /read-only/);
  // Saving roles keeps crew bots out of roles.json.
  orch.roles.save(orch.roles.list());
  const saved = JSON.parse(fs.readFileSync(path.join(orch.dataDir, 'roles.json'), 'utf8'));
  assert.ok(!saved.some((r) => r.name === 'ledge'));
  assert.ok(orch.roles.get('ledge'));
});

test('an answer that comes after the blocking limit wakes the agent with a new message', async () => {
  const { orch } = make({ settings: { blockSeconds: 0.1 } });
  const lead = orch.startTask({ role: 'lead', task: 'one piece' });
  const parent = orch.startTask({ role: 'lead', task: 'parent of a slow asker', provider: 'mock' });
  await until(orch, () => orch.inbox.filter((i) => i.kind === 'question').length === 2);
  // Nobody answers in time: both turns end, both agents wait on you.
  await until(orch, () => orch.runs.size === 0);
  assert.equal(orch.getAgent(lead.id).status, 'asking');
  const q = orch.inbox.find((i) => i.agentId === lead.id && i.kind === 'question');
  assert.equal(q.status, 'open');
  assert.equal(q.deferred, true);
  orch.answer(q.id, 'Wrap up');
  await until(orch, () => orch.getAgent(lead.id).status === 'done');
  assert.match(orch.getAgent(lead.id).report.summary, /You said: Wrap up/);
  // A child that asked late reports back once answered (not auto-reported while asking).
  const w = orch.startTask({ role: 'developer', task: 'ask about naming', parentId: parent.id });
  await until(orch, () => orch.getAgent(w.id).status === 'asking' && !orch.runs.has(w.id));
  assert.equal(orch.getAgent(w.id).report, null);
  orch.answer(orch.inbox.find((i) => i.agentId === w.id && i.status === 'open').id, 'Yes');
  await until(orch, () => orch.getAgent(w.id).status === 'done');
  assert.match(orch.getAgent(w.id).report.summary, /The human answered: Yes/);
  orch.stop(parent.id);
});

test('an instant answer (same tick as the question) is not lost', async () => {
  const { orch } = make();
  orch.on('update', () => {
    const q = openQuestion(orch);
    if (q) orch.answer(q.id, 'Yes');
  });
  const w = orch.startTask({ role: 'developer', task: 'ask quickly' });
  await until(orch, () => orch.getAgent(w.id).status === 'done');
  assert.match(orch.getAgent(w.id).report.summary, /The human answered: Yes/);
});
