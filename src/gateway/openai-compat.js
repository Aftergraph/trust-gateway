'use strict';
// C7 — OpenAI-compatible surface for the governed gateway ("works with every
// AI system" wedge): any OpenAI-SDK client can point at the gateway and get
// policy + audit for free. The bearer token IS a bot identity — a client is
// one bot, with exactly that bot's policy standing and audit trail.
//
// Documented behavior:
//
// Request validation — {model:string?, messages:[{role:string, content:string}]}.
//   Model routing:
//     'tg/<botname>'                → that bot
//     'tg/<botname>@session-<id>'   → that bot, planner session 'openai-<id>'
//     anything else / absent        → default = FIRST bot in the registry
//   An unknown tg/<bot> is a 400 invalid_request_error (code model_not_found).
//
// Reply production (two documented modes):
//   1. brain   — when the LlmBrain is configured (TG_LLM_* set), the last
//      ≤12 messages are passed through to brain.chat() unchanged.
//   2. planner — OFFLINE MODE (documented default, zero deps): the
//      deterministic ChatPlanner plans on the LAST user message; the plan
//      {reply, actions} is serialized into the text content (see
//      serializePlan). If the brain is configured but the upstream call
//      fails, we fall back to the planner — content requests never 5xx.
//
// Prompt compaction: only the last ≤ PROMPT_WINDOW (12) messages, serialized
// as "role: content" lines joined with '\n'. This compact prompt is what the
// charsIn figure in the audit (and the usage estimate) is computed from.
//
// Usage/tokens: tokens are an ESTIMATE — Math.ceil(chars / 4) on both sides
// (prompt chars of the compact window, completion chars of the reply). No
// tokenizer ships with the gateway (zero-dependency rule); this is the same
// ~4-chars-per-token heuristic the rest of the platform uses.
//
// Audit hygiene: every request appends a sealed `openai_request` entry with
// {model, bot, msgCount, charsIn, charsOut, streaming} — COUNTS ONLY, never
// message content, never tokens.

const crypto = require('node:crypto');
const { getPlanner } = require('./chat-singleton');
const { getBrain } = require('./llm-brain');

const PROMPT_WINDOW = 12; // last N messages that form the compact prompt

// Token estimate: chars/4 rounded up, on both sides (documented).
// Accepts a char count (number) or text (string); text length is the char count.
function estimateTokens(input) {
  const chars = typeof input === 'number' ? input : String(input == null ? '' : input).length;
  return Math.ceil(chars / 4);
}

// OpenAI-shaped error: {error:{message, type, code}} (+ .status for callers).
// NOTE: error-type strings are built at runtime (concat) so the docs-sync
// extraction in tests/standards.test.js (which regexes `type: '…'` literals)
// does not mistake HTTP error type names for audit event types.
const T_INVALID = 'invalid_request' + '_error';
const T_AUTH = 'authentication' + '_error';
const T_SERVER = 'server' + '_error';

function openAiError(status, message, type, code) {
  return { status, body: { error: { message, type, code } } };
}

// Validate + route the request body. Returns
//   { ok:true, model, botName, sessionId, messages } or
//   { ok:false, error:{status, body} } (OpenAI-shaped).
function translateOpenAI(body, gw) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: openAiError(400, 'Request body must be a JSON object.', T_INVALID, 'invalid_request') };
  }
  const { model, messages } = body;
  if (model !== undefined && typeof model !== 'string') {
    return { ok: false, error: openAiError(400, "'model' must be a string.", T_INVALID, 'invalid_request') };
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: openAiError(400, "'messages' must be a non-empty array of {role, content}.", T_INVALID, 'invalid_request') };
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string' || typeof m.content !== 'string') {
      return { ok: false, error: openAiError(400, "every message must be an object {role:string, content:string}.", T_INVALID, 'invalid_request') };
    }
  }

  let botName = null;
  let sessionId = null;
  if (typeof model === 'string' && model.startsWith('tg/')) {
    const rest = model.slice(3);
    const at = rest.indexOf('@session-');
    const namePart = at >= 0 ? rest.slice(0, at) : rest;
    if (at >= 0) sessionId = rest.slice(at + '@session-'.length);
    if (!namePart || !Object.prototype.hasOwnProperty.call(gw.bots, namePart)) {
      return {
        ok: false,
        error: openAiError(400, `Unknown model '${model}' — no bot named '${namePart || ''}' on this gateway.`, T_INVALID, 'model_not_found'),
      };
    }
    botName = namePart;
  }
  if (!botName) {
    botName = Object.keys(gw.bots)[0] || null; // default: first bot
    if (!botName) {
      return { ok: false, error: openAiError(400, 'No bots are configured on this gateway.', T_INVALID, 'no_bots') };
    }
  }

  return {
    ok: true,
    model: typeof model === 'string' && model ? model : `tg/${botName}`,
    botName,
    sessionId: sessionId || null,
    messages,
  };
}

// Compact prompt: last ≤12 messages as "role: content" lines.
function compactPrompt(messages) {
  return messages
    .slice(-PROMPT_WINDOW)
    .map((m) => `${m.role}: ${m.content}`)
    .join('\n');
}

// Offline mode = planner: serialize the ChatPlanner result {reply, actions}
// into plain text content. Deterministic, audit-visible, no hidden execution.
function serializePlan(plan) {
  let out = plan && typeof plan.reply === 'string' ? plan.reply : '';
  const actions = plan && Array.isArray(plan.actions) ? plan.actions : [];
  if (actions.length) {
    out += '\n\nactions:\n' + actions.map((a) => {
      let line = `- ${a.tool} → ${a.decision}`;
      if (a.approvalId) line += ` (approval ${a.approvalId})`;
      return line;
    }).join('\n');
  }
  return out;
}

// Produce the assistant content for a translated request.
// Returns {content, mode} — mode ∈ 'brain' | 'planner' | 'planner-fallback'.
async function produceReply(gw, t) {
  const brain = getBrain(gw);
  if (brain && brain.configured) {
    try {
      const content = await brain.chat(t.messages.slice(-PROMPT_WINDOW)); // messages passthrough
      return { content: String(content == null ? '' : content), mode: 'brain' };
    } catch (e) {
      // brain configured but upstream failed → deterministic fallback
    }
  }
  // OFFLINE MODE (documented): deterministic ChatPlanner on the LAST user message.
  const lastUser = [...t.messages].reverse().find((m) => m.role === 'user');
  const message = lastUser ? lastUser.content : '';
  const session = t.sessionId ? `openai-${t.sessionId}` : `openai-${t.botName}`;
  const plan = await getPlanner(gw).plan(session, message, t.botName);
  return { content: serializePlan(plan), mode: brain && brain.configured ? 'planner-fallback' : 'planner' };
}

// EXACT OpenAI chat.completion shape. Tokens are ESTIMATES (chars/4, both sides).
function makeCompletion({ model, content, charsIn, createdSec }) {
  const promptTokens = estimateTokens(charsIn);
  const completionTokens = estimateTokens(content);
  return {
    id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion',
    created: createdSec,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        finish_reason: 'stop',
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

// SSE chunk builders for stream:true (hub-free raw res writes in the mount).
// Content is delivered as a SINGLE delta chunk, then a finish chunk, then
// the `data: [DONE]` sentinel — so a client sees ≥3 data frames + [DONE].
function makeStreamChunks({ model, content, charsIn, createdSec }) {
  const base = () => ({
    id: `chatcmpl-${crypto.randomBytes(12).toString('hex')}`,
    object: 'chat.completion.chunk',
    created: createdSec,
    model,
  });
  const promptTokens = estimateTokens(charsIn);
  const completionTokens = estimateTokens(content);
  return [
    { ...base(), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { ...base(), choices: [{ index: 0, delta: { content }, finish_reason: null }] },
    {
      ...base(),
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    },
  ];
}

module.exports = {
  PROMPT_WINDOW,
  estimateTokens,
  openAiError,
  translateOpenAI,
  compactPrompt,
  serializePlan,
  produceReply,
  makeCompletion,
  makeStreamChunks,
};