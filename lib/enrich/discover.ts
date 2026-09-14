/**
 * Discovery sweep.
 *
 * For one entity × dimension, asks Claude (with the server-side web_search
 * tool, forced via tool_choice:"any", 20260209 revision) to surface NEW
 * public artifacts not already in the known-URL set. This is the ONLY path
 * that introduces new source ids into the pipeline.
 *
 * Mirrors lib/scan/websearch.ts: force tool use, strict-JSON final block,
 * resilient parsing, cap tool calls. Returns DiscoveredArtifact[] deduped
 * against the known URLs via itemId.
 */

import type Anthropic from "@anthropic-ai/sdk";

import { canonicalUrl, itemId } from "../activity.ts";
import { CLAUDE_MODEL, getLiteLLMClient } from "../litellm.ts";
import type { DiscoveredArtifact } from "./types.ts";

// Anthropic's server-side web_search tool (below) is Claude-only — the
// open-weight models on the TritonAI hub don't support it — so this stays
// on CLAUDE_MODEL rather than following the rest of the app to open-weight.
const SCAN_MODEL = process.env.SCAN_MODEL || CLAUDE_MODEL;
const DEFAULT_MAX_TOOL_USES = 4;

export type DiscoverArgs = {
  entityId: string;
  entityName: string;
  dimension: string;
  dimensionDescription: string;
  /** URLs already known (inventory + ledger) — excluded from results. */
  knownUrls: string[];
  lookbackDays: number;
  maxToolUses?: number;
};

function systemPrompt(lookbackDays: number): string {
  return `You find NEW public documents about how a specific University of California (or peer) institution governs and uses artificial intelligence, within one named dimension of AI activity. You MUST call the web_search tool at least once before answering.

Look for material that is current as of the past ${lookbackDays} day(s), OR is an enduring official artifact (policy, council charter, tool page, leadership appointment) you can verify is live right now.

A hit is a credible, citable public web page or PDF — an official institutional page, policy document, governance/council page, press release, or named-leadership announcement — that substantively concerns the named dimension for the named institution. Skip social posts, third-party blogs, attendee lists, and pages where the institution is only mentioned in passing.

Your final assistant message MUST be a single JSON object and nothing else:

{
  "artifacts": [
    {
      "title": "...",
      "url": "https://...",
      "published_at": "2026-05-04" or null,
      "issuer": "the office/body that published it",
      "snippet": "first ~300 chars of relevant context, plain text",
      "why_relevant": "one sentence: why this matters for the named dimension"
    }
  ]
}

If you genuinely found nothing live and new, return {"artifacts": []}. No prose, no code fences.`;
}

function userPrompt(args: DiscoverArgs): string {
  const excerpt = args.knownUrls.slice(0, 40).join("\n");
  return `Institution: "${args.entityName}" (id: ${args.entityId}).
Dimension: "${args.dimension}" — ${args.dimensionDescription}.

Already-known URLs (do NOT return these or close variants):
${excerpt || "(none)"}

Search the public web for NEW or currently-live official artifacts about this institution's "${args.dimension}" posture. Run at least one web_search call. Return strict JSON per the system instructions.`;
}

function extractFinalText(message: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function tryParseJson(text: string): { artifacts?: unknown } | null {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as { artifacts?: unknown };
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1)) as { artifacts?: unknown };
      } catch {
        return null;
      }
    }
    return null;
  }
}

export async function discoverSources(args: DiscoverArgs): Promise<DiscoveredArtifact[]> {
  const knownSet = new Set(args.knownUrls.map((u) => itemId(u)));
  let message: Anthropic.Message;
  try {
    message = await getLiteLLMClient().messages.create({
      model: SCAN_MODEL,
      max_tokens: 2048,
      system: systemPrompt(args.lookbackDays),
      messages: [{ role: "user", content: userPrompt(args) }],
      tool_choice: { type: "any" },
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: args.maxToolUses ?? DEFAULT_MAX_TOOL_USES },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
  } catch (err) {
    console.warn(
      `[enrich] discover failed ${args.entityId}.${args.dimension}: ${(err as Error).message}`,
    );
    return [];
  }

  const parsed = tryParseJson(extractFinalText(message));
  const rawList = Array.isArray(parsed?.artifacts) ? (parsed!.artifacts as unknown[]) : [];

  const out: DiscoveredArtifact[] = [];
  let ordinal = 0;
  for (const raw of rawList) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    if (!url || !/^https?:\/\//i.test(url)) continue;
    if (knownSet.has(itemId(url))) continue; // already known
    ordinal += 1;
    out.push({
      source_id: `disc-${args.entityId}-${args.dimension}-${ordinal}`,
      entity_id: args.entityId,
      dimension: args.dimension,
      title: typeof r.title === "string" ? r.title.slice(0, 300) : "",
      url: canonicalUrl(url),
      published_at: typeof r.published_at === "string" && r.published_at ? r.published_at : null,
      issuer: typeof r.issuer === "string" ? r.issuer.slice(0, 200) : "",
      snippet: typeof r.snippet === "string" ? r.snippet.slice(0, 400) : "",
      why_relevant: typeof r.why_relevant === "string" ? r.why_relevant.slice(0, 300) : "",
    });
  }
  return out;
}
