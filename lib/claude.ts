/**
 * Claude integration for the UCOP research copilot.
 *
 * Assembles the system prompt (mission, pillars, OAs, research
 * topics, principles, response style, and the full UCOP baseline),
 * applies prompt-cache breakpoints so every turn after the first
 * reuses the cached input, and exposes a thin streaming wrapper used
 * by /api/chat.
 *
 * Server-only.
 */

import "server-only";

import type Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  opportunityAreas,
  pillars,
  researchTopics,
} from "../content/northstar.ts";
import { baselineBlock } from "./baseline.ts";
import { committeeContextSummary } from "./committee.ts";
import { CLAUDE_MAX_TOKENS, cachedSystemBlocks, getLiteLLMClient } from "./litellm.ts";

// Open-weight by default — this system prompt uses no Anthropic-specific
// tools, so it doesn't need Claude. Override to fall back to a Claude model
// (see CLAUDE_MODEL in litellm.ts) if the open model's grounding/citation
// discipline proves inadequate in practice.
const CHAT_MODEL = process.env.CHAT_MODEL || "api-glm-5.3";

export {
  CLAUDE_MAX_TOKENS,
  CLAUDE_MODEL,
  LITELLM_BASE_URL,
  type Provider,
  getLiteLLMClient,
  assertLiteLLMConfigured,
} from "./litellm.ts";

/* ------------------------------------------------------------------ */
/* System prompt                                                       */
/* ------------------------------------------------------------------ */

/** Cached across calls — these strings never change per deploy. */
let cachedFramingBlock: string | null = null;
let cachedCommitteeBlock: string | null = null;

export function framingBlock(): string {
  if (cachedFramingBlock) return cachedFramingBlock;

  const principles = readFileSync(
    join(process.cwd(), "docs", "responsible-ai-seed-principles.md"),
    "utf-8",
  );

  const pillarsText = pillars
    .map(
      (p) =>
        `Pillar ${p.number} — ${p.name.toUpperCase()}: ${p.statement}`,
    )
    .join("\n");

  const oasText = opportunityAreas
    .map(
      (oa) =>
        `- OA-${oa.number} (${oa.pillar}) ${oa.title}: ${oa.summary}`,
    )
    .join("\n");

  const researchText = researchTopics
    .map((t) => `${t.number}. ${t.prompt}`)
    .join("\n");

  cachedFramingBlock = `You are the UCOP Research Copilot — an AI assistant for the UCOP AI Steering Committee. Your user relies on you for grounded, cite-every-claim answers about AI governance across the UC system.

## North Star

${pillarsText}

## Opportunity Areas

${oasText}

## Research Topics

${researchText}

## Responsible AI Principles (applied to your own outputs)

${principles}

## Grounding rules (non-negotiable)

1. Only make factual claims about UC entities that are supported by the BASELINE DATASET, and only make factual claims about Steering Committee members that are supported by the COMMITTEE DIRECTORY. If neither covers a claim, say so explicitly and recommend where the user could enrich the data.
2. Cite every factual claim with an inline marker:
   - For UC entities, use [entity_id] from the baseline (e.g. [ucop_systemwide], [uc_berkeley], [ucla_health], [lbnl]).
   - For committee members, use [member_id] from the committee directory (e.g. [neely-r], [goldberg-k], [khosla-p]). Member ids are lowercase last name, hyphen, first initial.
   Place the marker at the end of the sentence or bullet it supports. Multiple markers on one sentence are fine. Do not bracket Opportunity Area codes (write OA-1, not [OA-1]).
3. Never invent entity ids, member ids, source URLs, field names, or notes. When you want to quote something, quote it verbatim from the baseline notes or the member synopsis.
4. When asked to compare entities or members, prefer structured output — a short bulleted list or a small markdown table — over prose.
5. When asked to draft a memo, follow a tight structure: a one-sentence framing, 3–5 bullets of evidence with citations, and a short "open questions" list.
6. Do not invent member positions, opinions, or facts beyond the directory. Pass-1 enrichment is public-record-only; many members have not yet self-reported. If asked about a member's stance on something the directory doesn't cover, say "the directory doesn't cover this — that's what the self-report pass is for."
7. Don't conflate the current Steering Committee (Khosla, Williams, Palazoglu as co-chairs) with the previous AI Council (Bui and Bustamante co-chairs). Three current members served on the previous Council: Crittenden, Moe, Han — they are the institutional memory.

## Response style

- Terse and structural. Labels, headings, lists. Lead with the implication, not the setup.
- No hedging filler. No apologies. No "as an AI".
- Plain markdown. No code fences around prose.
- When there is no good answer from the baseline, say "The baseline does not cover this" and propose what source would.
`;

  return cachedFramingBlock;
}

export function committeeBlock(): string {
  if (cachedCommitteeBlock) return cachedCommitteeBlock;
  cachedCommitteeBlock = `## COMMITTEE DIRECTORY (UCOP AI Steering Committee)

The 23-member directory below is the authoritative source for every factual claim about a committee member. Each member appears with their member_id in [brackets], primary affiliation, opportunity-area mappings (primary/secondary), expertise tags with confidence, role facets, and a verified-public-record synopsis.

Citation rule: when you reference a member, cite as [member_id] (e.g., [neely-r], [goldberg-k]). Members map to one to three Opportunity Areas; one is designated primary. Confidence ratings reflect how directly the public record supports each tag — high = explicitly named, medium = implied or adjacent, low = inferred and flagged for verification.

${committeeContextSummary()}`;
  return cachedCommitteeBlock;
}

/** Prompt-cached system array. Three breakpoints: framing + baseline + committee. */
export function systemPrompt(): Anthropic.TextBlockParam[] {
  return [
    {
      type: "text",
      text: framingBlock(),
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: baselineBlock(),
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: committeeBlock(),
      cache_control: { type: "ephemeral" },
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Chat                                                                */
/* ------------------------------------------------------------------ */

export type ChatRole = "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

/**
 * Start a streaming Claude response for a user turn against the UCSD
 * TritonAI LiteLLM proxy. The caller is responsible for plumbing the
 * SDK's AsyncIterable of events into whatever transport they're using
 * (SSE from a Route Handler).
 */
export function startChatStream(
  messages: ChatMessage[],
  signal?: AbortSignal,
) {
  const client = getLiteLLMClient();
  console.info(`[chat] provider=litellm model=${JSON.stringify(CHAT_MODEL)}`);
  return client.messages.stream(
    {
      model: CHAT_MODEL,
      max_tokens: CLAUDE_MAX_TOKENS,
      system: cachedSystemBlocks(systemPrompt(), CHAT_MODEL),
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    },
    signal ? { signal } : undefined,
  );
}
