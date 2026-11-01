'use strict';
// A pretend agent for trying the app without Claude Code or Codex installed,
// and for tests. It uses the same crew tools as a real agent, so delegation,
// waiting, questions and reports all go through the real orchestrator code.
//
// Lead (role "lead"): splits the brief on new lines, ";" or " and ", delegates
// each piece, waits, asks you whether to wrap up, then reports.
// Worker: "works" for a moment, asks you a question if its brief says "ask",
// then reports.

function createMockProvider() {
  return {
    label: 'Demo (no AI)',
    available: () => true,
    run(ctx) {
      let killed = false;
      const sleep = (ms) => new Promise((r) => setTimeout(r, killed ? 0 : ms));
      const delay = ctx.mockDelayMs ?? 600;
      const say = (text) => !killed && ctx.onEvent({ kind: 'assistant', text });
      const tool = (name, args) => (killed ? Promise.resolve('') : ctx.callTool(name, args));

      const done = (async () => {
        if (!ctx.resume) ctx.onSession(`mock-${ctx.agent.id}`);
        const a = ctx.agent;
        const prompt = String(ctx.prompt);

        if (ctx.resume) {
          // A later turn: reports arriving, or you talking to it.
          await sleep(delay / 2);
          const late = /^The human answered your question\.\n[\s\S]*\nAnswer: ([\s\S]*)$/.exec(prompt);
          if (late) {
            say(`Thanks, picking it back up.`);
            await tool('report', { summary: a.role === 'lead' ? `Finished "${a.title}". You said: ${late[1]}.` : `Done: ${a.task}. (Demo agent: nothing was actually changed.) The human answered: ${late[1]}.` });
          } else if (/^## Report from/m.test(prompt)) {
            const n = (prompt.match(/^## Report from/gm) || []).length;
            say(`Got ${n} report(s). Checking them against the brief.`);
            if (/Everything you delegated has now reported back/.test(prompt) && a.role === 'lead') {
              await tool('report', { summary: `All pieces reported back.\n\n${prompt.split('\n\nEverything you delegated')[0]}` });
            }
          } else {
            say(`Noted: "${prompt.slice(0, 200)}". (Demo agent: a real Claude or Codex agent would act on this.)`);
          }
          ctx.onEvent({ kind: 'result', text: '', usage: {} });
          return { error: false };
        }

        if (a.role === 'lead') {
          const pieces = prompt
            .split(/\n+|;\s*|\s+and\s+/i)
            .map((s) => s.trim().replace(/^[-*\d.)\s]+/, ''))
            .filter((s) => s.length > 2)
            .slice(0, 4);
          say(`Splitting this into ${pieces.length} piece(s).`);
          const ids = [];
          for (const piece of pieces) {
            const role = /review|test|check/i.test(piece) ? 'reviewer' : /research|find|look up|compare/i.test(piece) ? 'researcher' : 'developer';
            const res = await tool('delegate', { role, task: piece, title: piece.slice(0, 60), provider: 'mock' });
            const m = /as (ag_[0-9a-f]+)/.exec(res);
            if (m) ids.push(m[1]);
          }
          if (ids.length) {
            const reports = await tool('wait_for_reports', { agent_ids: ids });
            say(`Reports are in:\n\n${reports}`);
          }
          if (killed) return { error: true };
          const ans = await tool('ask_human', {
            question: `All ${ids.length} piece(s) reported back. Wrap up, or add a review pass first?`,
            options: ['Wrap up', 'Add a review pass'],
          });
          if (/has not answered yet/.test(ans)) {
            say('Waiting for your answer before I wrap up.');
            return { error: false };
          }
          if (/review pass/i.test(ans)) {
            await tool('delegate', { role: 'reviewer', task: `Review the work on: ${prompt}`, title: 'Review pass', provider: 'mock' });
            await tool('wait_for_reports', {});
          }
          await tool('remember', { note: 'Demo: the human likes a quick check-in before wrap-up.' }).catch(() => {});
          await tool('report', { summary: `Finished "${a.title}". ${ids.length} piece(s) delegated and reported back. You said: ${String(ans).replace('The human answered: ', '')}.` });
          ctx.onEvent({ kind: 'result', text: '', usage: {} });
          return { error: !!killed };
        }

        say(`On it: ${a.task}`);
        await sleep(delay);
        ctx.onEvent({ kind: 'tool', name: 'Read', input: { file_path: 'README.md' } });
        await sleep(delay);
        let extra = '';
        if (/\bask\b/i.test(a.task)) {
          const ans = await tool('ask_human', { question: `Quick check on "${a.title}": go with the simple version?`, options: ['Yes', 'No, do it properly'] });
          if (/has not answered yet/.test(ans)) {
            say('Waiting for your answer.');
            return { error: false };
          }
          extra = ` ${ans}.`;
        }
        if (killed) return { error: true };
        await tool('report', { summary: `Done: ${a.task}. (Demo agent: nothing was actually changed.)${extra}` });
        ctx.onEvent({ kind: 'result', text: '', usage: {} });
        return { error: false };
      })();

      return {
        done,
        kill: () => {
          killed = true;
        },
      };
    },
  };
}

module.exports = { createMockProvider };
