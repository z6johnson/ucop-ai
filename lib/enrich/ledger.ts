/**
 * Source-freshness ledger for the enrichment pipeline.
 *
 * Tracks, per source URL, the last fetch outcome and a content hash so the
 * monthly run can detect (a) CHANGED sources (hash differs → re-extract)
 * and (b) DEAD sources (repeatedly 404/410 → propose a value:false gap for
 * any field that source currently backs).
 *
 * (b) is the sharpest edge in the pipeline: declaring a source dead is what
 * licenses run.ts to assert a campus no longer has something. So death is
 * narrow on purpose — see classifyFailure. Only "the server says this is
 * gone" counts. Being refused by a bot wall, or timing out, tells us about
 * the path to the document, not the document, and must never accumulate into
 * a claim about its contents.
 *
 * Reuses canonicalUrl + itemId from lib/activity.ts verbatim, so the ledger
 * keys match the rest of the project's URL-dedup scheme.
 *
 * Storage: data/enrich/source_ledger.json — pretty JSON + trailing newline,
 * identical in spirit to data/ucnfi-committee/activity/seen.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { canonicalUrl, itemId } from "../activity.ts";

/**
 * Number of consecutive "gone" fetches (404/410) before a source is dead.
 * Only `gone` failures count — see classifyFailure.
 */
export const DEAD_THRESHOLD = 2;

/**
 * Number of consecutive "blocked" fetches (401/403/429) before we surface the
 * source for manual checking. Much higher than DEAD_THRESHOLD because being
 * blocked says something about the WAF in front of the page, not about
 * whether the page exists — and it never justifies asserting absence.
 */
export const BLOCKED_REVIEW_THRESHOLD = 6;

export type SourceLedgerEntry = {
  source_id: string;
  url: string;
  /** sha256 of the last successfully fetched body, or null if never fetched OK. */
  content_hash: string | null;
  last_fetched: string; // ISO timestamp
  last_status: number | "error" | "dead";
  /**
   * The real HTTP status (or "error") from the most recent failure. Kept
   * separately because `last_status` is overwritten with the literal "dead"
   * on death, which used to destroy the evidence for why — leaving no way to
   * tell a genuinely removed page from one behind a bot wall.
   */
  last_error_status: number | "error" | null;
  /** When content_hash last changed (ISO), or null. */
  last_changed: string | null;
  first_seen: string; // ISO timestamp
  /** Consecutive failures of any kind — the overall health streak. */
  consecutive_failures: number;
  /** Consecutive `gone` failures only. This is what trips DEAD_THRESHOLD. */
  gone_failures: number;
  /** Consecutive `blocked` failures only. Trips BLOCKED_REVIEW_THRESHOLD. */
  blocked_failures: number;
};

export type SourceLedger = Record<string, SourceLedgerEntry>;

export function ledgerPath(repoRoot: string): string {
  return join(repoRoot, "data", "enrich", "source_ledger.json");
}

export function readLedger(repoRoot: string): SourceLedger {
  const p = ledgerPath(repoRoot);
  if (!existsSync(p)) return {};
  return JSON.parse(readFileSync(p, "utf-8")) as SourceLedger;
}

export function writeLedger(repoRoot: string, ledger: SourceLedger): void {
  const p = ledgerPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(ledger, null, 2) + "\n", "utf-8");
}

/** Ledger key for a URL — the same SHA256-of-canonical-URL id used elsewhere. */
export function ledgerKey(url: string): string {
  return itemId(url);
}

export type FreshnessVerdict =
  | "first_seen"
  | "unchanged"
  | "changed"
  | "transient_failure"
  | "blocked"
  | "dead";

/**
 * What a failed fetch actually tells us about the resource.
 *
 * The distinction is load-bearing: only `gone` is evidence the document no
 * longer exists, and only `gone` may accumulate toward declaring a source
 * dead — which in turn is what lets run.ts propose recording a field as
 * absent. A 403 means a bot wall stood between us and the page; a 500 means
 * the server had a bad day. Neither is evidence about the page's contents,
 * and treating them as such produced ~40 false "this campus dropped its AI
 * policy" proposals a month.
 */
export type FailureKind = "gone" | "blocked" | "transient";

export function classifyFailure(status: number | "error"): FailureKind {
  if (status === 404 || status === 410) return "gone";
  if (status === 401 || status === 403 || status === 429) return "blocked";
  return "transient";
}

/**
 * Records a fetch outcome into the ledger and returns the freshness verdict.
 * Mutates `ledger` in place. `nowIso` is injected for deterministic tests.
 */
export function recordFetch(
  ledger: SourceLedger,
  args: {
    source_id: string;
    url: string;
    ok: boolean;
    status: number | "error";
    contentHash: string | null;
    nowIso: string;
  },
): FreshnessVerdict {
  const key = ledgerKey(args.url);
  const prior = ledger[key];

  if (!args.ok) {
    const kind = classifyFailure(args.status);
    const failures = (prior?.consecutive_failures ?? 0) + 1;
    // Each streak only advances on its own kind, and resets otherwise: a page
    // that 403s this month and 404s next month is not two steps from death.
    const gone = kind === "gone" ? (prior?.gone_failures ?? 0) + 1 : 0;
    const blocked = kind === "blocked" ? (prior?.blocked_failures ?? 0) + 1 : 0;
    const dead = gone >= DEAD_THRESHOLD;
    ledger[key] = {
      source_id: args.source_id,
      url: canonicalUrl(args.url),
      content_hash: prior?.content_hash ?? null,
      last_fetched: args.nowIso,
      last_status: dead ? "dead" : args.status,
      last_error_status: args.status,
      last_changed: prior?.last_changed ?? null,
      first_seen: prior?.first_seen ?? args.nowIso,
      consecutive_failures: failures,
      gone_failures: gone,
      blocked_failures: blocked,
    };
    if (dead) return "dead";
    if (blocked >= BLOCKED_REVIEW_THRESHOLD) return "blocked";
    return "transient_failure";
  }

  const isFirst = !prior || prior.content_hash === null;
  const changed = !isFirst && prior.content_hash !== args.contentHash;
  ledger[key] = {
    source_id: args.source_id,
    url: canonicalUrl(args.url),
    content_hash: args.contentHash,
    last_fetched: args.nowIso,
    last_status: args.status,
    last_error_status: null,
    last_changed: changed ? args.nowIso : (prior?.last_changed ?? args.nowIso),
    first_seen: prior?.first_seen ?? args.nowIso,
    consecutive_failures: 0,
    gone_failures: 0,
    blocked_failures: 0,
  };
  if (isFirst) return "first_seen";
  return changed ? "changed" : "unchanged";
}

/** Drop entries last fetched more than `days` ago. Mutates and returns. */
export function pruneLedger(ledger: SourceLedger, days: number): SourceLedger {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  for (const [k, entry] of Object.entries(ledger)) {
    const t = Date.parse(entry.last_fetched);
    if (Number.isFinite(t) && t < cutoff) delete ledger[k];
  }
  return ledger;
}
