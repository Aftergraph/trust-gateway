'use strict';
// v2 chat planner — DETERMINISTIC (no LLM). The point of this slice is the
// governed loop, visible in the UI: proposal → policy → approval → sealed audit.
// LLM brain is a later slice; the interface ({reply, actions}) will not change.

const { classify, decide } = require('./policy');

const INTENTS = [
  { re: /^\s*(help|what can you do)\s*$/i, kind: 'help' },
  { re: /^\s*(status|report|how are (things|the bots))\s*$/i, kind: 'status' },
  { re: /\b(list|show)\s+(the\s+)?(pending|approvals)\b/i, kind: 'listPending' },
  { re: /\b(delete|remove|wipe|drop)\s+(.+)$/i, kind: 'propose', tool: (m) => `fs.delete:${m[2].trim()}`, args: () => null },
  { re: /\b(run|execute|shell)\s+(.+)$/i, kind: 'propose', tool: () => 'shell.run', args: (m) => ({ cmd: m[2].trim() }) },
  { re: /\b(write|save|create)\s+(file\s+)?([^\s:]+)\s*:?\s*(.*)$/i, kind: 'propose', tool: (m) => `fs.write:${m[3]}`, args: (m) => ({ content: m[4] || '' }) },
  { re: /\bread\s+(file\s+)?([^\s]+)$/i, kind: 'propose', tool: (m) => `fs.read:${m[2]}`, args: () => null },
  { re: /^\s*(hi|hello|hey)\s*$/i, kind: 'greet' },
];

const HELP = 'I can: read/write files, run commands, list pending approvals, report status. ' +
  'Examples: "read notes/x.md" · "save out.txt: hello" · "run deploy.sh" · "delete staging" · "status". ' +
  'Destructive proposals always wait for an operator approval.';

class ChatPlanner {
  constructor({ gateway }) {
    this.gw = gateway;
    this.sessions = new Map(); // name -> {created, history:[{role,text,ts}]}
    this.maxTurns = 50;
  }

  _session(name) {
    let s = this.sessions.get(name);
    if (!s) { s = { created: this.gw.now(), history: [] }; this.sessions.set(name, s); }
    return s;
  }

  _push(s, role, text) {
    s.history.push({ role, text: String(text).slice(0, 2000), ts: this.gw.now() });
    while (s.history.length > this.maxTurns * 2) s.history.shift();
  }

  listSessions() {
    return [...this.sessions.entries()].map(([name, s]) => ({
      name, created: s.created, turns: s.history.filter((h) => h.role === 'user').length,
    }));
  }

  async plan(sessionName, message, botName) {
    const gw = this.gw;
    const session = this._session(sessionName);
    this._push(session, 'user', message);

    // resolve acting bot
    const names = Object.keys(gw.bots);
    let botName_ = botName || names.find((n) => (gw.bots[n].role || 'worker') === 'worker') || names[0];
    if (!names.includes(botName_)) {
      const reply = `unknown bot "${botName_}"`;
      this._push(session, 'assistant', reply);
      return { reply, actions: [] };
    }
    const bot = { name: botName_, ...gw.bots[botName_] };

    const msg = String(message).trim();
    for (const intent of INTENTS) {
      const m = msg.match(intent.re);
      if (!m) continue;

      if (intent.kind === 'help' || intent.kind === 'greet') {
        const reply = intent.kind === 'help' ? HELP : `Hi — I'm the gateway console bot. ${HELP}`;
        this._push(session, 'assistant', reply);
        return { reply, actions: [] };
      }

      if (intent.kind === 'status') {
        const v = gw.chain.verify();
        const pending = gw.approvals.listPending().length;
        const reply = `chain: ${v.ok ? 'SEALED' : 'TAMPERED'} (${v.length} entries) · pending approvals: ${pending} · bots: ${names.join(', ')}`;
        this._push(session, 'assistant', reply);
        return { reply, actions: [] };
      }

      if (intent.kind === 'listPending') {
        const p = gw.approvals.listPending();
        const reply = p.length
          ? 'pending:\n' + p.map((r) => `  ${r.id} ${r.bot} → ${r.tool} (expires ${new Date(r.expiresAt).toISOString()})`).join('\n')
          : 'no pending approvals';
        this._push(session, 'assistant', reply);
        return { reply, actions: [] };
      }

      // propose an action through the SAME governed pipeline
      const tool = intent.tool(m);
      const args = intent.args(m);
      const cls = classify(tool);
      const verdict = decide({ tool, cls, bot });
      const action = { id: `act_${gw.chain.head.seq + 1}`, tool, decision: verdict.decision, reason: verdict.reason };
      gw._audit({ type: 'chat_action', session: sessionName, bot: botName_, tool, class: cls, decision: verdict.decision, reason: verdict.reason, argsLength: args ? JSON.stringify(args).length : 0 });

      if (verdict.decision === 'allow' && gw.dispatch) {
        try {
          action.result = await gw.dispatch(botName_, tool, args);
          gw._audit({ type: 'chat_action_executed', bot: botName_, tool, ok: true });
        } catch (e) {
          action.error = 'dispatch_failed';
          gw._audit({ type: 'chat_action_executed', bot: botName_, tool, ok: false, error: String(e && e.message).slice(0, 200) });
        }
      } else if (verdict.decision === 'needs_approval') {
        const approval = gw.approvals.request({ bot: { name: botName_ }, tool, args, reason: `chat proposal: ${verdict.reason}` });
        gw._audit({ type: 'approval_requested', approvalId: approval.id, bot: botName_, tool, class: cls });
        action.approvalId = approval.id;
      }

      const reply =
        action.decision === 'allow' && action.result ? `done: ${JSON.stringify(action.result)}` :
        action.decision === 'allow' && action.error ? `failed: dispatch error (audited)` :
        action.decision === 'needs_approval' ? `proposed ${tool} — waiting for operator approval (${action.approvalId})` :
        `denied: ${action.reason}`;
      this._push(session, 'assistant', reply);
      return { reply, actions: [action] };
    }

    const reply = 'I did not understand. Try "read X", "save file: text", "run cmd", "delete X", "status", or "help".';
    this._push(session, 'assistant', reply);
    return { reply, actions: [] };
  }
}

module.exports = { ChatPlanner, INTENTS };