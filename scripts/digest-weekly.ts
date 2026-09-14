/**
 * Weekly committee AI-activity digest.
 *
 * Reads the last 7 days of activity items, calls the UCSD TritonAI
 * LiteLLM proxy with prompt caching on the unchanging committee block,
 * and writes a markdown digest under data/ucnfi-committee/activity/digests/.
 *
 * Usage:
 *   npm run digest:weekly
 *   END_DATE=2026-05-04 npm run digest:weekly  # week ending on a specific date
 *   DRY_RUN=1 npm run digest:weekly            # build, print, don't write
 *
 * Env required:
 *   LITELLM_API_KEY
 *
 * Optional:
 *   DIGEST_MODEL  — defaults to api-deepseek-v4-flash (open-weight)
 *   END_DATE      — YYYY-MM-DD, defaults to today
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { digestPath } from "../lib/activity.ts";
import { buildWeeklyDigest } from "../lib/scan/digest.ts";

const REPO_ROOT = process.cwd();
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const END_DATE_RAW = process.env.END_DATE?.trim() || null;

function parseEndDate(): Date {
  if (!END_DATE_RAW) return new Date();
  const t = Date.parse(END_DATE_RAW + "T12:00:00Z");
  if (!Number.isFinite(t)) {
    console.error(`[digest] invalid END_DATE=${END_DATE_RAW}; expected YYYY-MM-DD`);
    process.exit(2);
  }
  return new Date(t);
}

async function main(): Promise<void> {
  const endDate = parseEndDate();
  console.info(`[digest] start end_date=${endDate.toISOString().slice(0, 10)} dry_run=${DRY_RUN}`);

  const result = await buildWeeklyDigest(REPO_ROOT, endDate);
  console.info(
    `[digest] built week=${result.isoWeek} dates=${result.dates[0]}..${result.dates[result.dates.length - 1]} items=${result.itemCount}`,
  );

  if (DRY_RUN) {
    console.info("[digest] dry run — markdown follows:");
    console.info("---");
    console.info(result.markdown);
    return;
  }

  const out = digestPath(REPO_ROOT, result.isoWeek);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, result.markdown, "utf-8");
  console.info(`[digest] wrote ${out}`);
}

main().catch((err) => {
  console.error("[digest] fatal:", err);
  process.exit(1);
});
