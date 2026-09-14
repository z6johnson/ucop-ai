/**
 * Weekly UC President's Brief — generator entry point.
 *
 * Pulls the RSS feeds (external / peer / vendor), a live web-search pass
 * over the TritonAI LiteLLM `internet_tool` MCP, and the committee signal,
 * drafts three to five items with an LLM via the same LiteLLM proxy,
 * validates every baseline anchor, and writes a PUBLISHED markdown edition
 * under data/brief/editions/.
 *
 * Usage:
 *   npm run brief:weekly
 *   END_DATE=2026-05-29 npm run brief:weekly        # week ending on a specific date
 *   DRY_RUN=1 npm run brief:weekly                  # build, print, don't write
 *   LOOKBACK_DAYS=14 npm run brief:weekly           # widen the RSS feed window
 *   WEB_LOOKBACK_DAYS=14 npm run brief:weekly       # widen the web-search window
 *   DISABLE_WEB=1 npm run brief:weekly              # RSS-only run, no web search
 *
 * Env required:
 *   LITELLM_API_KEY      — TritonAI bearer token (LLM synthesis + grounded search)
 *
 * Optional:
 *   LITELLM_BASE_URL     — defaults to https://tritonai-api.ucsd.edu
 *   LITELLM_OPENAI_URL   — defaults to ${LITELLM_BASE_URL}/v1/chat/completions
 *   SEARCH_MODEL         — grounded web-search model (default gemini-3.5-flash)
 *   BRIEF_MODEL          — defaults to CLAUDE_MODEL (the Brief stays on
 *                          Claude by default; it's the flagship weekly
 *                          document and the one place quality is worth the
 *                          cost over the open-weight models used elsewhere)
 *   END_DATE             — YYYY-MM-DD, defaults to today
 *   LOOKBACK_DAYS        — external/peer/vendor RSS lookback, default 7
 *   WEB_LOOKBACK_DAYS    — web-search lookback, default = LOOKBACK_DAYS
 *   DISABLE_WEB          — set to 1 to skip the live web-search pass
 *   COMMITTEE_GRACE_DAYS — committee-signal publication-recency window, default 30
 *                          (wider than LOOKBACK_DAYS because member positions
 *                          often surface in a scan after they were published)
 *
 * The edition is written with status: "published" and goes live on /brief
 * immediately — there is no human review gate. The primary user catches and
 * tunes any issues on the next scheduled refresh.
 */

import { existsSync, readFileSync } from "node:fs";

import { isoNowUTC } from "../lib/activity.ts";
import { generateBrief } from "../lib/brief/generate.ts";
import {
  readEdition,
  rejectedPath,
  serializeEdition,
  sourcesConfigPath,
  writeEdition,
  writeRejected,
} from "../lib/brief/storage.ts";
import type { SourcesConfig } from "../lib/brief/types.ts";

const REPO_ROOT = process.cwd();
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const END_DATE_RAW = process.env.END_DATE?.trim() || null;
const LOOKBACK_DAYS = process.env.LOOKBACK_DAYS ? Number(process.env.LOOKBACK_DAYS) : 7;
const WEB_LOOKBACK_DAYS = process.env.WEB_LOOKBACK_DAYS
  ? Number(process.env.WEB_LOOKBACK_DAYS)
  : LOOKBACK_DAYS;
const DISABLE_WEB = process.env.DISABLE_WEB === "1" || process.env.DISABLE_WEB === "true";
const COMMITTEE_GRACE_DAYS = process.env.COMMITTEE_GRACE_DAYS
  ? Number(process.env.COMMITTEE_GRACE_DAYS)
  : 30;

function parseEndDate(): Date {
  if (!END_DATE_RAW) return new Date();
  const t = Date.parse(END_DATE_RAW + "T12:00:00Z");
  if (!Number.isFinite(t)) {
    console.error(`[brief] invalid END_DATE=${END_DATE_RAW}; expected YYYY-MM-DD`);
    process.exit(2);
  }
  return new Date(t);
}

function loadSourcesConfig(): SourcesConfig {
  const p = sourcesConfigPath(REPO_ROOT);
  if (!existsSync(p)) {
    console.error(`[brief] sources_config.json not found at ${p}`);
    process.exit(2);
  }
  const raw = readFileSync(p, "utf-8");
  const parsed = JSON.parse(raw) as Partial<SourcesConfig>;
  return {
    external: parsed.external ?? [],
    vendor: parsed.vendor ?? [],
    peers: parsed.peers ?? [],
  };
}

async function main(): Promise<void> {
  const endDate = parseEndDate();
  const config = loadSourcesConfig();

  console.info(
    `[brief] start end_date=${endDate.toISOString().slice(0, 10)} ` +
      `external=${config.external.length} vendor=${config.vendor.length} ` +
      `peers=${config.peers.length} lookback=${LOOKBACK_DAYS} ` +
      `web_lookback=${WEB_LOOKBACK_DAYS} web=${DISABLE_WEB ? "off" : "on"} ` +
      `committee_grace=${COMMITTEE_GRACE_DAYS} dry_run=${DRY_RUN}`,
  );

  const { edition, validation, rawItems } = await generateBrief({
    repoRoot: REPO_ROOT,
    endDate,
    config,
    feedLookbackDays: LOOKBACK_DAYS,
    webLookbackDays: WEB_LOOKBACK_DAYS,
    disableWeb: DISABLE_WEB,
    committeeGraceDays: COMMITTEE_GRACE_DAYS,
  });

  console.info(
    `[brief] collected raw=${rawItems.length} ` +
      `(external=${edition.inputs_manifest.external.n} ` +
      `web=${edition.inputs_manifest.web.n} ` +
      `peer=${edition.inputs_manifest.peer.n} ` +
      `vendor=${edition.inputs_manifest.vendor.n} ` +
      `committee=${edition.inputs_manifest.committee_signal_dates.length} dates)`,
  );
  console.info(
    `[brief] drafted week=${edition.edition_id} accepted=${validation.accepted.length} rejected=${validation.rejected.length}`,
  );
  for (const r of validation.rejected) {
    console.warn(`[brief]   rejected "${r.item.headline}": ${r.reasons.join("; ")}`);
  }

  if (DRY_RUN) {
    console.info("[brief] dry run — edition follows:");
    console.info("---");
    console.info(serializeEdition(edition));
    return;
  }

  // Empty-edition guard. A zero-item edition is only legitimate when the
  // week was genuinely empty (no raw inputs at all — handled upstream by
  // emptyEdition). If we collected inputs but ended up with no items, the
  // generation failed (truncated/unparseable model response, or every
  // draft rejected). Publishing it would overwrite any existing edition
  // for the week with a blank one AND report a green run while shipping an
  // empty Brief. Refuse to write, preserve what's on disk, and exit non-zero.
  if (edition.items.length === 0 && rawItems.length > 0) {
    if (validation.rejected.length > 0) {
      // Preserve the audit trail of what was drafted-and-rejected.
      const rejectedFile = writeRejected(REPO_ROOT, edition.edition_id, {
        edition_id: edition.edition_id,
        rejected_at: isoNowUTC(),
        items: validation.rejected.map((r) => ({
          headline: r.item.headline,
          reasons: r.reasons,
          raw: r.item,
        })),
      });
      console.error(
        `[brief] FAILED: all ${validation.rejected.length} drafted item(s) failed validation; ` +
          `wrote rejection sidecar ${rejectedFile}.`,
      );
    } else {
      console.error(
        `[brief] FAILED: model returned no parseable items from ${rawItems.length} raw input(s) ` +
          `(likely a truncated or malformed response). Not publishing an empty Brief.`,
      );
    }
    const existing = readEdition(REPO_ROOT, edition.edition_id);
    if (existing && existing.items.length > 0) {
      console.error(
        `[brief] left existing ${edition.edition_id} edition (${existing.items.length} item(s)) untouched.`,
      );
    }
    process.exit(1);
  }

  // Don't clobber a non-empty published edition with a genuinely empty one
  // either — a stale-but-real Brief beats a blank page on a re-run.
  if (edition.items.length === 0) {
    const existing = readEdition(REPO_ROOT, edition.edition_id);
    if (existing && existing.items.length > 0) {
      console.warn(
        `[brief] week ${edition.edition_id} has no items but an existing edition has ` +
          `${existing.items.length} — keeping the existing edition, nothing written.`,
      );
      return;
    }
  }

  const out = writeEdition(REPO_ROOT, edition);
  console.info(`[brief] wrote ${out}`);

  if (validation.rejected.length > 0) {
    const rejectedFile = writeRejected(REPO_ROOT, edition.edition_id, {
      edition_id: edition.edition_id,
      rejected_at: isoNowUTC(),
      items: validation.rejected.map((r) => ({
        headline: r.item.headline,
        reasons: r.reasons,
        raw: r.item,
      })),
    });
    console.info(`[brief] wrote rejection sidecar ${rejectedFile}`);
  } else {
    // No rejections; leave any stale sidecar alone (the reviewer can
    // delete it manually if it's confusing).
    const staleSidecar = rejectedPath(REPO_ROOT, edition.edition_id);
    if (existsSync(staleSidecar)) {
      console.info(`[brief] note: stale rejection sidecar exists at ${staleSidecar}`);
    }
  }

  console.info(
    `[brief] published data/brief/editions/${edition.edition_id}.md with status=${edition.status} (${edition.items.length} item(s)) — live on /brief.`,
  );
}

main().catch((err) => {
  console.error("[brief] fatal:", err);
  process.exit(1);
});
