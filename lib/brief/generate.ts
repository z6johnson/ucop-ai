/**
 * Brief generator.
 *
 * Pulls four feeds, calls an LLM with structured-output instructions,
 * validates every anchor against the live baseline / peer baseline /
 * committee directory, and returns the draft edition. The caller
 * (scripts/brief-weekly.ts) writes it to disk.
 */

import type Anthropic from "@anthropic-ai/sdk";

import {
  isoNowUTC,
  isoWeekLabel,
} from "../activity.ts";
import { cachedSystemBlocks, getLiteLLMClient } from "../litellm.ts";
import { collectCommitteeSignal } from "./sources/committee.ts";
import { collectExternal } from "./sources/external.ts";
import { collectPeerMoves } from "./sources/peers.ts";
import { collectVendor } from "./sources/vendor.ts";
import { collectWeb } from "./sources/web.ts";
import {
  baselineBlock,
  briefFramingBlock,
  committeeContextSummary,
  peerBaselineBlock,
  userInputsBlock,
} from "./prompt.ts";
import { windowBounds } from "./recency.ts";
import { validateItems, type ValidationResult } from "./validate.ts";
import type {
  BriefEdition,
  BriefItem,
  BriefRawItem,
  EditionStatus,
  InputsManifest,
  SourcesConfig,
} from "./types.ts";

// Open-weight by default, same as chat/digest/extract — try it before paying
// for Claude. This is the one call site where that's a real bet: editions
// auto-publish with no human review gate (see AUTO_REVIEWER below), so a
// quality regression ships straight to the Brief's readers. The one backstop
// is validateItems() below, which strips any item whose anchors don't check
// out against the live baseline/peer/committee data regardless of model —
// it catches fabrication, not weak analysis. Set BRIEF_MODEL=<CLAUDE_MODEL
// value> to fall back to Claude if an open-weight edition reads worse.
const BRIEF_MODEL = process.env.BRIEF_MODEL || "api-glm-5.3";
/**
 * Output budget for the drafting call. Three to five items, each carrying
 * four prose fields plus feed_sources / baseline_anchors / peer_anchors /
 * experts arrays, routinely run past 4k tokens — and a truncated response
 * parses to zero items (see parseDraftResponse), silently publishing an
 * empty Brief. 8k leaves headroom; override with BRIEF_MAX_TOKENS.
 */
const BRIEF_MAX_TOKENS = process.env.BRIEF_MAX_TOKENS
  ? Number(process.env.BRIEF_MAX_TOKENS)
  : 8192;
/** Stamped into reviewed_by since editions auto-publish without a human gate. */
const AUTO_REVIEWER = "auto";

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export type GenerateBriefOpts = {
  repoRoot: string;
  endDate: Date;
  config: SourcesConfig;
  /** Lookback for external / peer / vendor RSS feeds. Default 7 days. */
  feedLookbackDays?: number;
  /** Lookback for the live web-search pass. Default = feedLookbackDays. */
  webLookbackDays?: number;
  /** Days of committee activity JSONL files to read, by discovery date. Default 7. */
  committeeWindowDays?: number;
  /** Publication-recency grace window for committee signal. Default 30 days. */
  committeeGraceDays?: number;
  /** Skip the live web-search pass (RSS-only run). Default false. */
  disableWeb?: boolean;
};

export type GenerateBriefResult = {
  edition: BriefEdition;
  validation: ValidationResult;
  rawItems: BriefRawItem[];
};

export async function generateBrief(
  opts: GenerateBriefOpts,
): Promise<GenerateBriefResult> {
  const feedLookback = opts.feedLookbackDays ?? 7;
  const webLookback = opts.webLookbackDays ?? feedLookback;
  const committeeWindow = opts.committeeWindowDays ?? 7;
  const committeeGrace = opts.committeeGraceDays ?? 30;

  // Recency windows, anchored to endDate (never wall-clock now) so a
  // regenerated or backfilled Brief is deterministic.
  const strict = windowBounds(opts.endDate, feedLookback);
  const grace = windowBounds(opts.endDate, committeeGrace);

  // Collect the feeds in parallel. Each collector swallows its own
  // errors so one broken RSS endpoint (or an unreachable web-search
  // gateway) doesn't sink the whole run.
  const [external, peer, vendor, web, committee] = await Promise.all([
    collectExternal({ config: opts.config, lookbackDays: feedLookback, endDate: opts.endDate }),
    collectPeerMoves({ config: opts.config, lookbackDays: feedLookback, endDate: opts.endDate }),
    collectVendor({ config: opts.config, lookbackDays: feedLookback, endDate: opts.endDate }),
    opts.disableWeb
      ? Promise.resolve([])
      : collectWeb({ lookbackDays: webLookback, endDate: opts.endDate }),
    Promise.resolve(
      collectCommitteeSignal({
        repoRoot: opts.repoRoot,
        endDate: opts.endDate,
        windowDays: committeeWindow,
        graceDays: committeeGrace,
      }),
    ),
  ]);

  // Web search frequently surfaces the same press / Federal Register URLs
  // the RSS feeds already carried. Dedup by stable id in priority order,
  // keeping the first occurrence so the richer RSS subkind wins over the
  // generic web_search one — and so the model and the validator both see
  // each URL exactly once.
  const seen = new Set<string>();
  const keep = (items: BriefRawItem[]): BriefRawItem[] => {
    const out: BriefRawItem[] = [];
    for (const it of items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      out.push(it);
    }
    return out;
  };
  const externalU = keep(external);
  const peerU = keep(peer);
  const vendorU = keep(vendor);
  const webU = keep(web);
  const committeeU = keep(committee.items);

  const allRaw = [...externalU, ...peerU, ...vendorU, ...webU, ...committeeU];
  const isoWeek = isoWeekLabel(opts.endDate);
  const windowFrom = strict.startIso;
  const windowTo = strict.endIso;

  const manifest: InputsManifest = {
    external: { from: windowFrom, to: windowTo, n: externalU.length },
    peer: { from: windowFrom, to: windowTo, n: peerU.length },
    vendor: { from: windowFrom, to: windowTo, n: vendorU.length },
    web: { from: windowFrom, to: windowTo, n: webU.length },
    committee_signal_dates: committee.windowDates,
  };

  // Empty-input short-circuit: if every bucket is empty, return an
  // edition with zero items in draft state. No reason to call the
  // model to say "nothing happened" — and Claude would helpfully
  // invent something if asked.
  if (allRaw.length === 0) {
    return emptyEdition({
      isoWeek,
      endDate: opts.endDate,
      manifest,
      rawItems: allRaw,
    });
  }

  const userPrompt = userInputsBlock({
    isoWeek,
    windowFrom,
    windowTo,
    external: externalU,
    peer: peerU,
    vendor: vendorU,
    web: webU,
    committee: committeeU,
  });

  const message = await getLiteLLMClient().messages.create({
    model: BRIEF_MODEL,
    max_tokens: BRIEF_MAX_TOKENS,
    system: cachedSystemBlocks(
      [
        {
          type: "text",
          text: briefFramingBlock(),
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: baselineBlock(),
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: peerBaselineBlock(),
          cache_control: { type: "ephemeral" },
        },
        {
          type: "text",
          text: `## COMMITTEE DIRECTORY\n\n${committeeContextSummary()}`,
          cache_control: { type: "ephemeral" },
        },
      ],
      BRIEF_MODEL,
    ),
    messages: [{ role: "user", content: userPrompt }],
  });

  const drafted = parseDraftResponse(message);
  // A zero-item draft from a non-empty input set is an anomaly: the model
  // is instructed to return three to five items. The usual culprit is a
  // truncated (max_tokens) or otherwise unparseable response, which
  // parseDraftResponse swallows into []. Log the stop_reason and a snippet
  // so the run is debuggable instead of silently shipping an empty Brief —
  // mirrors the web-search path's "unparseable response" diagnostic.
  if (drafted.length === 0) {
    const rawText = extractText(message);
    console.warn(
      `[brief] draft produced 0 items stop=${message.stop_reason ?? "?"} ` +
        `raw_len=${rawText.length} snippet=${JSON.stringify(rawText.slice(0, 400))}`,
    );
  }
  const validation = validateItems(drafted, allRaw, {
    strictStartMs: strict.startMs,
    committeeStartMs: grace.startMs,
    endMs: strict.endMs,
    strictLabel: `${strict.startIso}..${strict.endIso}`,
    committeeLabel: `${grace.startIso}..${grace.endIso}`,
  });

  // Auto-published: the primary user opted out of the human review gate,
  // so the edition goes straight to the site. reviewed_by records that no
  // human signed off rather than leaving it blank.
  const edition: BriefEdition = {
    edition_id: isoWeek,
    week_ending: windowTo,
    status: "published" as EditionStatus,
    reviewed_by: AUTO_REVIEWER,
    reviewed_at: isoNowUTC(),
    generated_at: isoNowUTC(),
    generated_by_model: BRIEF_MODEL,
    inputs_manifest: manifest,
    items: validation.accepted,
  };

  return { edition, validation, rawItems: allRaw };
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

function extractText(message: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  return parts.join("\n").trim();
}

function tryParseJson(text: string): unknown | null {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch {
    // Last resort: first { ... last }
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(s.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function parseDraftResponse(message: Anthropic.Message): BriefItem[] {
  const text = extractText(message);
  const parsed = tryParseJson(text);
  if (!parsed || typeof parsed !== "object") return [];
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  // The structure is trusted to the validator — here we just shape
  // it to BriefItem and let validateItems reject anything broken.
  return items.map((raw, idx) => normalizeItem(raw, idx + 1));
}

function normalizeItem(raw: unknown, ordinal: number): BriefItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const itemId =
    typeof r.item_id === "string" && r.item_id.trim()
      ? r.item_id.trim()
      : `item-${ordinal}`;
  const priorityRaw = Number(r.priority);
  const priority: 1 | 2 | 3 | 4 =
    priorityRaw === 1 || priorityRaw === 2 || priorityRaw === 3 || priorityRaw === 4
      ? (priorityRaw as 1 | 2 | 3 | 4)
      : 1;
  return {
    item_id: itemId,
    priority,
    headline: stringField(r.headline),
    what_happened: stringField(r.what_happened),
    why_it_matters: stringField(r.why_it_matters),
    for_the_committee: stringField(r.for_the_committee),
    feed_sources: Array.isArray(r.feed_sources)
      ? (r.feed_sources as BriefItem["feed_sources"])
      : [],
    baseline_anchors: Array.isArray(r.baseline_anchors)
      ? (r.baseline_anchors as BriefItem["baseline_anchors"])
      : [],
    peer_anchors: Array.isArray(r.peer_anchors)
      ? (r.peer_anchors as BriefItem["peer_anchors"])
      : [],
    experts: Array.isArray(r.experts)
      ? (r.experts as BriefItem["experts"])
      : [],
  };
}

function stringField(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/* ------------------------------------------------------------------ */
/* Date helpers (local to the generator)                               */
/* ------------------------------------------------------------------ */

function isoDateOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function emptyEdition(args: {
  isoWeek: string;
  endDate: Date;
  manifest: InputsManifest;
  rawItems: BriefRawItem[];
}): GenerateBriefResult {
  const edition: BriefEdition = {
    edition_id: args.isoWeek,
    week_ending: isoDateOf(args.endDate),
    status: "published",
    reviewed_by: AUTO_REVIEWER,
    reviewed_at: isoNowUTC(),
    generated_at: isoNowUTC(),
    generated_by_model: BRIEF_MODEL,
    inputs_manifest: args.manifest,
    items: [],
  };
  return {
    edition,
    validation: { accepted: [], rejected: [] },
    rawItems: args.rawItems,
  };
}
