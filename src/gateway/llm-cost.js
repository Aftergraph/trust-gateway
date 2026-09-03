'use strict';
// F4 — local cost/credit estimator for chat completions.
//
// Assumption (documented in code, not a guarantee):
//   tokenCount = Math.ceil(charCount / 4)
// This mirrors OpenAI's rule of thumb for tokenization. The platform
// MUST NOT fabricate model prices — estCost is always null unless a
// price list is configured externally.
//
// localLimit is the conservative default context-window guard used
// when the model's true max is unknown. Dialagram is known to be
// limited; 4096 is the local ceiling applied as a safety bound.

const { SYSTEM_PROMPT } = require('./llm-brain');

// Conservative local context-window limit when the model's true max
// is not known. Dialagram is known to be limited — 4096 chars/4 tokens
// is the hard gate applied by the preview endpoint.
const LOCAL_LIMIT = 4096;

/**
 * Estimate token usage for a chat completion request.
 *
 * @param {{messages: Array<{role:string, content:string}>, model?: string}} opts
 * @returns {{promptTokens: number, completionTokens: number, totalTokens: number, chars: number, estCost: null | {provider:'remote'|'local', note:string}}}
 */
function estimateChat({ messages, model }) {
  if (!Array.isArray(messages)) {
    return { promptTokens: 0, completionTokens: 0, totalTokens: 0, chars: 0, estCost: null };
  }

  let chars = 0;
  for (const m of messages) {
    chars += String(m.content ?? '').length;
  }

  const promptTokens = Math.ceil(chars / 4);
  // Completion estimate: responses are typically shorter than prompts.
  // Use a conservative 1:2 ratio (completion ≈ 50% of prompt tokens).
  const completionTokens = Math.ceil(chars / 8);
  const totalTokens = promptTokens + completionTokens;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    chars,
    estCost: null, // MUST NOT fabricate prices — no price list configured
  };
}

module.exports = { estimateChat, LOCAL_LIMIT, SYSTEM_PROMPT };