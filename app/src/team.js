'use strict';
// "Describe how you want the agents to work" -> a team (roles + providers + pace).
// Uses Claude Code when it's installed; otherwise a simple keyword reading so the
// feature still works offline. Either way you see the team before it's applied.

const { spawn } = require('child_process');
const { childEnv } = require('./providers/common');
const { slug } = require('./roles');

const SHAPE = `Return only JSON, no prose, in this shape:
{"pace":"thrifty|balanced|max","roles":[{"name":"kebab-case","description":"one line","provider":"claude|codex","pace":"thrifty|balanced|max","instructions":"standing instructions for every agent with this role, 2-6 sentences"}]}
Rules: always include a "lead" role that coordinates and delegates. 2 to 8 roles. Use codex only where the description asks for Codex/OpenAI or for a second opinion; otherwise claude.
"thrifty" = cheap/fast models, "max" = the strongest models. Default "balanced".`;

const KNOWN = [
  { re: /\b(develop|developer|dev|engineer|coder|code|build|implement)/i, name: 'developer', description: 'Writes and changes code.', instructions: 'Make the change, run the project\'s own checks, and report what changed and how you verified it.' },
  { re: /\b(review|reviewer|reviews|audit)/i, name: 'reviewer', description: 'Reviews other agents\' work.', instructions: 'Review the work you are pointed at. Report concrete findings, most severe first, or say plainly you found nothing.' },
  { re: /\b(test|tests|tester|qa|testing)/i, name: 'tester', description: 'Writes and runs tests.', instructions: 'Write or run the tests that prove the change works. Report what passed and what failed with the output.' },
  { re: /\b(research|researcher|investigate|look up|sources?)/i, name: 'researcher', description: 'Finds and checks information.', instructions: 'Give every finding a source. Say what you checked and what you are guessing.' },
  { re: /\b(writer|writing docs|docs|documentation|copywriting|blog posts?|articles?)\b/i, name: 'writer', description: 'Writes docs and prose.', instructions: 'Write plainly and briefly for the stated reader. Report where the text lives.' },
  { re: /\b(design|designer|ui|ux)/i, name: 'designer', description: 'Designs interfaces.', instructions: 'Propose the design, explain the trade-offs, and keep it consistent with what exists.' },
  { re: /\b(travel|trip|flights?|hotels?)/i, name: 'travel-manager', description: 'Plans trips and remembers travel preferences.', instructions: 'Plan against the human\'s saved preferences. Never book or pay; ask first.' },
];

function heuristicTeam(text) {
  const t = String(text || '');
  const sentences = t.split(/(?<=[.!?\n])\s+/);
  const pace = /\b(cheap|thrifty|save|slow down|budget|low usage)\b/i.test(t) ? 'thrifty' : /\b(fast|max|best|strongest|speed up)\b/i.test(t) ? 'max' : 'balanced';
  const roles = [
    { name: 'lead', description: 'Coordinates: splits the work, delegates, checks reports, answers to you.', provider: /lead[^.]*codex/i.test(t) ? 'codex' : 'claude', pace, instructions: 'You coordinate. Break the request into pieces, delegate each to the best role, wait for reports, and check them before you report back.' },
  ];
  for (const k of KNOWN) {
    const hit = sentences.find((s) => k.re.test(s));
    if (!hit) continue;
    roles.push({ name: k.name, description: k.description, provider: /codex|openai|gpt/i.test(hit) ? 'codex' : 'claude', pace, instructions: k.instructions });
  }
  if (roles.length === 1) roles.push({ ...KNOWN[0], provider: 'claude', pace, re: undefined });
  return { pace, roles: roles.map(({ re, ...r }) => r), source: 'keywords' };
}

function parseTeam(text) {
  const m = String(text).match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON in the reply.');
  const team = JSON.parse(m[0]);
  if (!Array.isArray(team.roles) || !team.roles.length) throw new Error('The reply had no roles.');
  team.roles = team.roles.map((r) => ({
    name: slug(r.name),
    description: String(r.description || ''),
    provider: r.provider === 'codex' ? 'codex' : 'claude',
    pace: ['thrifty', 'balanced', 'max'].includes(r.pace) ? r.pace : 'balanced',
    instructions: String(r.instructions || ''),
  })).filter((r) => r.name);
  if (!team.roles.some((r) => r.name === 'lead')) team.roles.unshift(heuristicTeam('').roles[0]);
  if (!['thrifty', 'balanced', 'max'].includes(team.pace)) team.pace = 'balanced';
  return team;
}

function designTeam(description, { claudeBin, timeoutMs = 120000 } = {}) {
  if (!claudeBin) return Promise.resolve(heuristicTeam(description));
  return new Promise((resolve) => {
    const prompt = `Design a team of AI agents from this description.\n\n<description>\n${description}\n</description>\n\n${SHAPE}`;
    const child = spawn(claudeBin, ['-p', prompt, '--output-format', 'json', '--model', 'sonnet', '--tools', ''], { env: childEnv({}), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ ...heuristicTeam(description), note: 'Claude Code could not be started; read the description by keywords instead.' }));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        const outer = JSON.parse(out);
        resolve({ ...parseTeam(outer.result || ''), source: 'claude' });
      } catch (e) {
        resolve({ ...heuristicTeam(description), note: `Claude's answer couldn't be read (${e.message}); read the description by keywords instead.` });
      }
    });
  });
}

module.exports = { designTeam, heuristicTeam, parseTeam };
