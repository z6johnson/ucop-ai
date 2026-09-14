/**
 * Field extractor.
 *
 * For one entity × dimension, given the CURRENT canonical slice plus the
 * source material gathered this run (refreshed source bodies + newly
 * discovered artifacts), asks Claude to propose CandidateFields as deltas.
 *
 * Modeled on lib/brief/generate.ts: a cached framing system block, strict
 * JSON output, resilient parsing. The model is told to (a) propose only
 * what the provided sources support, (b) cite a source_id/source_url drawn
 * ONLY from the provided set, (c) prefer the existing field names. The
 * validator independently enforces the source-set rule, so the prompt is a
 * guide, not a guarantee.
 */

import type Anthropic from "@anthropic-ai/sdk";

import type { FieldRecord } from "../baseline.ts";
import { cachedSystemBlocks, getLiteLLMClient } from "../litellm.ts";
import type { CandidateField } from "./types.ts";

// Deliberately its own env var, not ENRICH_MODEL: that one also drives
// committee_verify.ts's web_search-tool call (see enrich-monthly.ts), which
// needs a Claude model. Extraction here is plain structured-JSON output, no
// tools, so it defaults to an open-weight model instead.
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || "api-deepseek-v4-flash";
const EXTRACT_MAX_TOKENS = 3072;

/** One source the model may cite. */
export type SourceForExtract = {
  source_id: string;
  title: string;
  url: string;
  issuer: string;
  published_at: string | null;
  /** Snippet or fetched-text excerpt to ground the extraction. */
  excerpt: string;
};

export type ExtractArgs = {
  entityId: string;
  entityName: string;
  dimension: string;
  dimensionDescription: string;
  /** Current canonical fields for this entity×dimension (field → record). */
  currentSlice: Record<string, FieldRecord>;
  sources: SourceForExtract[];
  /** Existing field names across this dimension, to encourage reuse. */
  fieldNameHints: string[];
};

function framingBlock(): string {
  return `You extract governance FACTS about University of California (and peer) institutions into structured FieldRecords for an authoritative AI-activity baseline. You NEVER invent. You propose a field only when a provided source directly supports it.

A FieldRecord is { value, source_id, source_url, notes }:
- value: a boolean (most fields are has_* booleans), or a short string (e.g. a title or an "equivocal"/"adapted" status), or a number. Use true only when the source affirmatively shows the thing exists.
- source_id / source_url: MUST be copied from one of the provided sources. Never cite a URL that is not in the provided source list.
- notes: one or two sentences of evidence, quoting or closely paraphrasing the source. Required for every non-false value.

Field naming: lowercase snake_case, usually prefixed has_ for booleans (e.g. has_ai_council, has_use_policy). Reuse an existing field name from the hints when the fact matches one; only mint a new name for a genuinely new fact.

Propose DELTAS only: a field absent from the current slice (new coverage), or a field whose value the sources now contradict or update. Do not restate unchanged fields unless a fresh source re-confirms a previously single-sourced claim.`;
}

function userPrompt(args: ExtractArgs): string {
  const sourceList = args.sources
    .map(
      (s) =>
        `### ${s.source_id} — ${s.title}\nurl: ${s.url}\nissuer: ${s.issuer}\npublished: ${s.published_at ?? "?"}\nexcerpt: ${s.excerpt.slice(0, 1500)}`,
    )
    .join("\n\n");

  return `Institution: "${args.entityName}" (id: ${args.entityId}).
Dimension: "${args.dimension}" — ${args.dimensionDescription}.

Existing field names in this dimension (reuse where the fact matches): ${args.fieldNameHints.join(", ") || "(none yet)"}.

CURRENT canonical slice for ${args.entityId}.${args.dimension}:
\`\`\`json
${JSON.stringify(args.currentSlice, null, 2)}
\`\`\`

SOURCES gathered this run (cite source_id/source_url ONLY from these):

${sourceList || "(no sources)"}

Return a single JSON object and nothing else:
{
  "candidates": [
    {
      "field": "has_ai_council",
      "value": true,
      "source_id": "<one of the source ids above>",
      "source_url": "<the matching url>",
      "notes": "evidence sentence",
      "confidence": "high" | "medium" | "low"
    }
  ]
}
If the sources support no new or changed fields, return {"candidates": []}. No prose, no code fences.`;
}

function extractText(message: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function tryParseJson(text: string): { candidates?: unknown } | null {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as { candidates?: unknown };
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1)) as { candidates?: unknown };
      } catch {
        return null;
      }
    }
    return null;
  }
}

function normalizeConfidence(v: unknown): "high" | "medium" | "low" {
  return v === "high" || v === "medium" || v === "low" ? v : "low";
}

export async function extractCandidates(args: ExtractArgs): Promise<CandidateField[]> {
  // Empty-input short-circuit: never ask the model "what's new" with nothing
  // to read — it would hallucinate. The caller should already skip empty
  // cells, but guard here too.
  if (args.sources.length === 0) return [];

  let message: Anthropic.Message;
  try {
    message = await getLiteLLMClient().messages.create({
      model: EXTRACT_MODEL,
      max_tokens: EXTRACT_MAX_TOKENS,
      system: cachedSystemBlocks(
        [{ type: "text", text: framingBlock(), cache_control: { type: "ephemeral" } }],
        EXTRACT_MODEL,
      ),
      messages: [{ role: "user", content: userPrompt(args) }],
    });
  } catch (err) {
    console.warn(
      `[enrich] extract failed ${args.entityId}.${args.dimension}: ${(err as Error).message}`,
    );
    return [];
  }

  const parsed = tryParseJson(extractText(message));
  const rawList = Array.isArray(parsed?.candidates) ? (parsed!.candidates as unknown[]) : [];

  const out: CandidateField[] = [];
  for (const raw of rawList) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const field = typeof r.field === "string" ? r.field.trim() : "";
    if (!field) continue;
    const value =
      typeof r.value === "boolean" ||
      typeof r.value === "number" ||
      typeof r.value === "string" ||
      r.value === null
        ? (r.value as FieldRecord["value"])
        : null;
    const record: FieldRecord = {
      value,
      source_id: typeof r.source_id === "string" ? r.source_id : null,
      source_url: typeof r.source_url === "string" ? r.source_url : null,
      notes: typeof r.notes === "string" ? r.notes : null,
    };
    out.push({
      entity_id: args.entityId,
      dimension: args.dimension,
      field,
      record,
      source_artifact_id: record.source_id ?? "",
      confidence: normalizeConfidence(r.confidence),
    });
  }
  return out;
}
