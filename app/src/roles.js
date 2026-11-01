'use strict';
// Roles and their memory. A role is a named job ("developer", "travel-manager")
// with standing instructions. Each role keeps one memory file that every agent
// with that role reads, across projects.

const fs = require('fs');
const path = require('path');

const DEFAULT_ROLES = [
  {
    name: 'lead',
    description: 'Takes the request, splits it into pieces, delegates, checks the reports and answers to you.',
    provider: 'claude',
    pace: 'balanced',
    instructions:
      'You coordinate. Break the request into pieces, delegate each to the best role, and wait for reports. ' +
      'Check the reports against the request before you report back. Do small things yourself rather than delegating them.',
  },
  {
    name: 'developer',
    description: 'Writes and changes code.',
    provider: 'claude',
    pace: 'balanced',
    instructions: 'Make the change, run the project\'s own checks, and report what changed and how you verified it.',
  },
  {
    name: 'reviewer',
    description: 'Reviews and tests other agents\' work.',
    provider: 'codex',
    pace: 'balanced',
    instructions:
      'Review the work you are pointed at. Run the tests. Report concrete findings with file and line, most severe first, ' +
      'or say plainly that you found nothing.',
  },
  {
    name: 'researcher',
    description: 'Reads code, docs and the web and reports findings with sources.',
    provider: 'claude',
    pace: 'thrifty',
    instructions: 'Give every finding a source. Say what you checked and what you are guessing.',
  },
];

const ROLE_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

function slug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

class RoleStore {
  constructor(dataDir, { crewDir } = {}) {
    this.dataDir = dataDir;
    this.crewDir = crewDir || null;
    this.file = path.join(dataDir, 'roles.json');
    this.memDir = path.join(dataDir, 'memory');
    fs.mkdirSync(this.memDir, { recursive: true });
    this.roles = this._load();
  }

  _load() {
    let roles;
    try {
      roles = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      roles = DEFAULT_ROLES.map((r) => ({ ...r }));
      fs.writeFileSync(this.file, JSON.stringify(roles, null, 2));
    }
    return roles.concat(this._crewRoles(roles));
  }

  // Puffin Crew bots (crew/<name>/persona.md) show up as read-only roles.
  // Their memory.md is level-gated in the crew, so this app never writes it.
  _crewRoles(existing) {
    if (!this.crewDir || !fs.existsSync(this.crewDir)) return [];
    const taken = new Set(existing.map((r) => r.name));
    const out = [];
    for (const entry of fs.readdirSync(this.crewDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const persona = path.join(this.crewDir, entry.name, 'persona.md');
      if (!fs.existsSync(persona) || taken.has(entry.name)) continue;
      const text = fs.readFileSync(persona, 'utf8');
      const firstLine = text.split('\n').find((l) => l.trim() && !l.startsWith('#')) || '';
      out.push({
        name: entry.name,
        description: `Puffin Crew bot. ${firstLine.trim().slice(0, 140)}`,
        provider: 'claude',
        pace: 'balanced',
        instructions: text,
        source: 'crew',
        memoryReadOnly: true,
        memoryPath: path.join(this.crewDir, entry.name, 'memory.md'),
      });
    }
    return out;
  }

  list() {
    return this.roles.map((r) => ({ ...r }));
  }

  get(name) {
    return this.roles.find((r) => r.name === name) || null;
  }

  // Replace the editable roles. Crew roles are re-read from disk, not saved.
  save(roles) {
    const clean = [];
    const seen = new Set();
    for (const r of roles) {
      if (r.source === 'crew') continue;
      const name = slug(r.name);
      if (!ROLE_NAME.test(name) || seen.has(name)) continue;
      seen.add(name);
      clean.push({
        name,
        description: String(r.description || '').slice(0, 300),
        provider: r.provider === 'codex' ? 'codex' : r.provider === 'mock' ? 'mock' : 'claude',
        pace: ['thrifty', 'balanced', 'max'].includes(r.pace) ? r.pace : 'balanced',
        instructions: String(r.instructions || '').slice(0, 8000),
      });
    }
    if (!seen.has('lead')) clean.unshift({ ...DEFAULT_ROLES[0] });
    fs.writeFileSync(this.file, JSON.stringify(clean, null, 2));
    this.roles = clean.concat(this._crewRoles(clean));
    return this.list();
  }

  memoryPath(name) {
    const role = this.get(name);
    if (role && role.memoryPath) return role.memoryPath;
    return path.join(this.memDir, `${slug(name) || 'unnamed'}.md`);
  }

  readMemory(name) {
    try {
      return fs.readFileSync(this.memoryPath(name), 'utf8');
    } catch {
      return '';
    }
  }

  writeMemory(name, text) {
    const role = this.get(name);
    if (role && role.memoryReadOnly) throw new Error(`Memory for "${name}" is read-only here (it belongs to the Puffin Crew and is level-gated there).`);
    fs.writeFileSync(this.memoryPath(name), String(text));
  }

  appendMemory(name, note) {
    const role = this.get(name);
    if (role && role.memoryReadOnly) throw new Error(`Memory for "${name}" is read-only here (it belongs to the Puffin Crew and is level-gated there).`);
    const line = `- ${new Date().toISOString().slice(0, 10)}: ${String(note).replace(/\s+/g, ' ').trim()}\n`;
    fs.appendFileSync(this.memoryPath(name), line);
    return line.trim();
  }
}

module.exports = { RoleStore, DEFAULT_ROLES, slug };
