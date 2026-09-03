'use strict';
// Trust Gateway v2 — wave D (D4): the brain decorator that closes the loop
// between fetched web content and the LLM prompt.
//
// Wiring story: mounts/22-chat-llm.js obtains the brain via getBrain(gw),
// and llm-brain.js exposes setBrain(gw, brain) precisely so later waves can
// decorate without editing W1's file. decorateBrain(gw) replaces the stored
// brain with a thin wrapper whose propose() quarantines every untrusted
// source BEFORE the inner brain ever sees it. That covers today's only
// caller (the chat mount) and gives tomorrow's tool-call loop (D1 llm-loop,
// built in parallel — DO NOT import it from here) the same primitives:
//
//   quarantineUntrusted(source)          → one envelope, budgeted per turn
//   decorateBrain(gw)                    → wraps + re-installs via setBrain
//   decorateBrain(gw, {brain})           → pure wrapper, no gw state touched
//
// Integration contract (see tests/trust.test.js for the one-call example):
//   decorated.propose(message, { session, bot, untrusted })
//     untrusted = {origin, content} | a webtools result {url, title, text}
//                 | an array of either. Each source is appended to the
//                 message as a quarantine envelope (trust.js), never raw.
//     Remaining opts are forwarded to the inner propose() untouched.
//
// Budget honesty: LlmBrain._push clamps every turn's content to 2000 chars
// on the way into history. A >2000-char message would lose its closing
// sentinel to that clamp — an open-ended envelope is worse than none — so
// we budget each envelope to the room actually left and truncate with an
// explicit marker instead. If llm-brain ever changes its clamp, change
// TURN_BUDGET_CHARS in lockstep (it reads as a coupling, not a coincidence).

const { getBrain, setBrain } = require('./llm-brain');
const { quarantineWrap } = require('./trust');

const TURN_BUDGET_CHARS = 2000;

// One untrusted source → one budgeted envelope. Accepts the explicit
// {origin, content} shape or a webtools/web-executor result ({url, text}).
function quarantineUntrusted(source, { maxChars = TURN_BUDGET_CHARS } = {}) {
  const s = source && typeof source === 'object' ? source : {};
  const origin = typeof s.origin === 'string' && s.origin
    ? s.origin
    : (typeof s.url === 'string' && s.url ? `web_fetch:${s.url}` : 'unknown');
  const content = s.content != null ? s.content : (s.text != null ? s.text : '');
  return quarantineWrap(origin, content, { maxChars });
}

function asList(untrusted) {
  if (!untrusted) return [];
  return Array.isArray(untrusted) ? untrusted : [untrusted];
}

// decorateBrain(gw, {brain}?) → decorated brain (idempotent per brain).
// With gw and no explicit brain: getBrain → wrap → setBrain, so every
// existing getBrain(gw) caller (mount 22, future D1) picks it up unchanged.
function decorateBrain(gw, { brain = null } = {}) {
  const inner = brain || (gw ? getBrain(gw) : null);
  if (!inner) throw new Error('decorateBrain: pass gw or an explicit brain');
  if (inner.__trustDecorated) return inner;

  const decorated = {
    __trustDecorated: true,
    inner,
    get configured() { return Boolean(inner.configured); },
    chat: (input) => inner.chat(input),
    async propose(message, opts = {}) {
      let msg = typeof message === 'string' ? message : String(message == null ? '' : message);
      for (const source of asList(opts.untrusted)) {
        const sep = 2; // the '\n\n' joining message and envelope
        const room = TURN_BUDGET_CHARS - msg.length - sep;
        if (room <= 0) break; // no budget left: operator text wins, content is dropped
        msg = `${msg}\n\n${quarantineUntrusted(source, { maxChars: room })}`;
      }
      const forwarded = { ...opts };
      delete forwarded.untrusted; // ours — the inner brain must not double-wrap
      return inner.propose(msg, forwarded);
    },
  };

  if (gw && !brain) setBrain(gw, decorated);
  return decorated;
}

module.exports = { decorateBrain, quarantineUntrusted, TURN_BUDGET_CHARS };
