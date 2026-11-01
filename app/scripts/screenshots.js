#!/usr/bin/env node
'use strict';
// Drives the real desktop app with the demo crew and saves screenshots.
// Needs Playwright (npm i -D playwright) and, on Linux without a display, xvfb-run.
// Usage: node scripts/screenshots.js [out_dir]
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright');

(async () => {
  const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'out'));
  fs.mkdirSync(out, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-shots-'));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(__dirname, '..'), '--no-sandbox'],
    // Offline team design so screenshots don't spend money.
    env: { ...process.env, CREW_DATA_DIR: dataDir, CREW_TEAM_OFFLINE: '1' },
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(e.message));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await win.setViewportSize({ width: 1440, height: 900 });
  await win.waitForSelector('.welcome');
  await win.screenshot({ path: path.join(out, '1-welcome.png') });

  await win.click('#welcome-demo');
  await win.waitForSelector('.item.question', { timeout: 20000 });
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(out, '2-question-in-inbox.png') });

  // Answer the worker's question from the inbox, then wait for the lead's.
  await win.click('.item.question .opts button');
  await win.waitForFunction(() => document.querySelector('.item.question .item-text')?.textContent.includes('Wrap up'), null, { timeout: 20000 });
  await win.screenshot({ path: path.join(out, '3-lead-asks.png') });
  await win.click('.item.question .opts button');
  await win.waitForSelector('.pill.s-done', { timeout: 20000 });
  await win.click('[data-tab="reports"]');
  await win.waitForTimeout(200);
  await win.screenshot({ path: path.join(out, '4-done-report.png') });

  // A child agent, opened from the tree.
  const nodes = await win.$$('.node');
  await nodes[2].click();
  await win.waitForTimeout(300);
  await win.screenshot({ path: path.join(out, '5-child-agent.png') });

  // Team from plain English.
  await win.click('#btn-team');
  await win.fill('#team-text', 'A developer writes the code. Codex reviews every change and runs the tests. A researcher looks things up. Keep it cheap.');
  await win.click('#team-design');
  await win.waitForFunction(() => document.querySelector('#team-note').textContent.length > 0, null, { timeout: 150000 });
  await win.screenshot({ path: path.join(out, '6-team.png') });
  await win.keyboard.press('Escape');

  const counts = await win.evaluate(() => ({ nodes: document.querySelectorAll('.node').length, reports: document.querySelectorAll('.item.report').length }));
  console.log(JSON.stringify({ out, counts, errors }));
  await app.close();
  process.exit(errors.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
