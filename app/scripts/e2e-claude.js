#!/usr/bin/env node
'use strict';
// End-to-end check with the real Claude Code CLI (costs a few cents on Haiku):
// a lead delegates to a developer, waits, asks you a question (auto-answered
// here), and reports. Run: npm run e2e
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Orchestrator } = require('../src/orchestrator');
const { createBridge } = require('../src/bridge');
const { createClaudeProvider } = require('../src/providers/claude');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-e2e-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-e2e-work-'));
  const holder = {};
  const bridge = createBridge({ toolCall: (...a) => holder.orch.toolCall(...a) });
  await bridge.start();
  const orch = (holder.orch = new Orchestrator({
    dataDir,
    providers: { claude: createClaudeProvider({ bridge }) },
    // E2E_LATE=1: answer questions after the blocking limit, so the answer has
    // to wake the agent with a resumed session.
    settings: { pace: 'thrifty', permissionMode: 'ask', defaultCwd: work, ...(process.env.E2E_LATE ? { blockSeconds: 3 } : {}) },
  }));
  if (!orch.providers.claude.available()) {
    console.error('claude is not on PATH');
    process.exit(2);
  }
  orch.roles.save(orch.roles.list().map((r) => ({ ...r, provider: 'claude', pace: 'thrifty' })));

  orch.on('update', () => {
    for (const item of orch.inbox) {
      if (item.status !== 'open' || item.kind === 'report') continue;
      if (item._seen) continue;
      item._seen = true;
      console.log(`[inbox] ${item.kind}: ${item.text}`);
      const reply = () => orch.answer(item.id, item.kind === 'approval' ? { allow: true } : item.options && item.options.length ? item.options[0] : 'Go ahead');
      if (process.env.E2E_LATE && item.kind === 'question') setTimeout(reply, 10000);
      else reply();
    }
  });

  const lead = orch.startTask({
    role: 'lead',
    task:
      'This is a test of the crew tools. Do exactly this, and nothing else:\n' +
      '1. Use the crew delegate tool to give the developer role this task: "Reply with the single word BANANA. Then call the crew report tool with summary BANANA."\n' +
      '2. Call wait_for_reports.\n' +
      '3. Use ask_human to ask "Ready to wrap up?" with options ["Yes","No"].\n' +
      '4. Call report with a summary that quotes the developer\'s report and the human\'s answer.',
  });

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const a = orch.getAgent(lead.id);
    if (['done', 'idle', 'failed', 'blocked'].includes(a.status) && !orch.runs.size) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const show = (a, depth = 0) => {
    console.log(`${'  '.repeat(depth)}- ${a.role} [${a.status}] ${a.provider} $${a.usage.costUsd.toFixed(4)} session=${a.sessionId}`);
    if (a.report) console.log(`${'  '.repeat(depth)}  report: ${a.report.summary.replace(/\n/g, ' ').slice(0, 300)}`);
    for (const k of orch.children(a.id)) show(k, depth + 1);
  };
  show(orch.getAgent(lead.id));

  const kids = orch.children(lead.id);
  const ok =
    kids.length === 1 &&
    kids[0].role === 'developer' &&
    /BANANA/.test(kids[0].report?.summary || '') &&
    /BANANA/.test(orch.getAgent(lead.id).report?.summary || '') &&
    orch.inbox.some((i) => i.kind === 'question' && i.status === 'answered');
  console.log(ok ? 'E2E PASS' : 'E2E FAIL');
  orch.flush();
  bridge.closeAll();
  await bridge.stop();
  process.exit(ok ? 0 : 1);
})();
