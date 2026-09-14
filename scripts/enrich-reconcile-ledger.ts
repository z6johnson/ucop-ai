/**
 * Re-probe failing sources against the corrected liveness rules.
 *
 * The ledger was written by a fetcher that sent a bare tool User-Agent and by
 * a recorder that counted every non-OK response toward death. Campus WAFs
 * 403 that UA, so sources that were serving fine accumulated "failures" until
 * they were marked dead — and a dead source is what licenses the monthly run
 * to propose recording a field as absent. That is where the recurring
 * "this campus dropped its AI policy" proposals came from.
 *
 * This re-fetches every entry that is currently dead or mid-failure using the
 * browser-leaning UA from lib/http.ts, and rewrites its streaks under
 * classifyFailure. Anything that responds is restored; anything that still
 * 404s keeps its gone streak and stays dead. Safe to re-run.
 *
 * Usage:
 *   npm run reconcile:ledger
 *   npm run reconcile:ledger -- --dry-run
 */

import { isoNowUTC } from "../lib/activity.ts";
import { fetchSource } from "../lib/enrich/fetch.ts";
import {
  classifyFailure,
  readLedger,
  writeLedger,
  DEAD_THRESHOLD,
  type SourceLedgerEntry,
} from "../lib/enrich/ledger.ts";

const REPO_ROOT = process.cwd();
const DRY_RUN = process.argv.includes("--dry-run");

type Outcome = "recovered" | "still_gone" | "blocked" | "transient";

function describe(entry: SourceLedgerEntry): string {
  return `${entry.source_id} (${entry.last_status}) ${entry.url}`;
}

async function main(): Promise<void> {
  const ledger = readLedger(REPO_ROOT);
  const nowIso = isoNowUTC();

  const suspect = Object.entries(ledger).filter(
    ([, e]) => e.last_status === "dead" || e.consecutive_failures > 0,
  );

  console.info(
    `[reconcile] ${Object.keys(ledger).length} ledger entries, ` +
      `${suspect.length} dead or failing — re-probing${DRY_RUN ? " (dry run)" : ""}.`,
  );

  const tally: Record<Outcome, string[]> = {
    recovered: [],
    still_gone: [],
    blocked: [],
    transient: [],
  };

  for (const [key, entry] of suspect) {
    const res = await fetchSource({ url: entry.url, type: "web" });

    if (res.ok) {
      // Fully restore: a responding source has no failure history worth keeping.
      ledger[key] = {
        ...entry,
        content_hash: res.contentHash,
        last_fetched: nowIso,
        last_status: res.status,
        last_error_status: null,
        // Treat this as the new content baseline rather than claiming it
        // "changed" — we never had a trustworthy hash to compare against.
        last_changed: entry.last_changed ?? nowIso,
        consecutive_failures: 0,
        gone_failures: 0,
        blocked_failures: 0,
      };
      tally.recovered.push(describe(entry));
      continue;
    }

    const kind = classifyFailure(res.status);
    const gone = kind === "gone" ? Math.max(entry.gone_failures ?? 0, DEAD_THRESHOLD) : 0;
    ledger[key] = {
      ...entry,
      last_fetched: nowIso,
      // Only a genuine 404/410 keeps the source dead.
      last_status: kind === "gone" ? "dead" : res.status,
      last_error_status: res.status,
      consecutive_failures: (entry.consecutive_failures ?? 0) + 1,
      gone_failures: gone,
      blocked_failures: kind === "blocked" ? (entry.blocked_failures ?? 0) + 1 : 0,
    };
    tally[kind === "gone" ? "still_gone" : kind === "blocked" ? "blocked" : "transient"].push(
      `${entry.source_id} (HTTP ${res.status}) ${entry.url}`,
    );
  }

  for (const [outcome, items] of Object.entries(tally)) {
    if (items.length === 0) continue;
    console.info(`\n[reconcile] ${outcome} — ${items.length}`);
    for (const line of items) console.info(`  ${line}`);
  }

  if (DRY_RUN) {
    console.info("\n[reconcile] dry run — ledger not written.");
    return;
  }
  writeLedger(REPO_ROOT, ledger);
  console.info(
    `\n[reconcile] wrote data/enrich/source_ledger.json — ` +
      `${tally.recovered.length} recovered, ${tally.still_gone.length} genuinely gone, ` +
      `${tally.blocked.length} blocked, ${tally.transient.length} transient.`,
  );
}

main().catch((err) => {
  console.error("[reconcile] fatal:", err);
  process.exit(1);
});
