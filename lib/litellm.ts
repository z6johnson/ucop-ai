/**
 * LiteLLM client + model config for the UCOP app.
 *
 * No "server-only" import: this module is shared by Next.js server
 * code (via lib/claude.ts) and the Node CLI scan/digest scripts, so it
 * must resolve under plain `node --experimental-strip-types` as well.
 */

import Anthropic from "@anthropic-ai/sdk";

export const CLAUDE_MAX_TOKENS = 4096;
// `||` (not `??`) so empty-string env vars — what GitHub Actions
// produces from an unset `vars.X` interpolation — fall back to the
// default. With `??` we'd send `model: ""` to the API and 400 out.
export const LITELLM_BASE_URL =
  process.env.LITELLM_BASE_URL || "https://tritonai-api.ucsd.edu";
// claude-sonnet-4-6 was pulled from the TritonAI model hub (403s with no
// configured fallback) — claude-sonnet-5 is its replacement. Keep CLAUDE_MODEL
// pointed at a Claude model: it's the default for call sites that need
// Anthropic-specific features (the server-side web_search tool), not just a
// generic "the LLM" knob.
export const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5";

export type Provider = "litellm";

export function isClaudeModel(model: string): boolean {
  return model.startsWith("claude-");
}

/**
 * `cache_control` (prompt caching) is an Anthropic-specific request field.
 * Strip it from system blocks when the resolved model isn't a Claude model,
 * so routing a call to an open-weight model on the same LiteLLM proxy
 * doesn't send it an unsupported param.
 */
export function cachedSystemBlocks(
  blocks: Anthropic.TextBlockParam[],
  model: string,
): Anthropic.TextBlockParam[] {
  if (isClaudeModel(model)) return blocks;
  return blocks.map(({ cache_control: _cache_control, ...rest }) => rest);
}

let litellmClient: Anthropic | null = null;

export function getLiteLLMClient(): Anthropic {
  if (!litellmClient) {
    const authToken = process.env.LITELLM_API_KEY;
    if (!authToken) {
      throw new Error("LITELLM_API_KEY is not set.");
    }
    litellmClient = new Anthropic({
      authToken,
      baseURL: LITELLM_BASE_URL,
      apiKey: null,
    });
  }
  return litellmClient;
}

export function assertLiteLLMConfigured(): void {
  if (!process.env.LITELLM_API_KEY) {
    throw new Error("LITELLM_API_KEY is not set.");
  }
}
