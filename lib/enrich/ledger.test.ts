import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLOCKED_REVIEW_THRESHOLD,
  DEAD_THRESHOLD,
  classifyFailure,
  ledgerKey,
  recordFetch,
  type SourceLedger,
} from "./ledger.ts";

const URL = "https://technology.berkeley.edu/AI";
const KEY = ledgerKey(URL);

/** Replays `n` failed fetches of the same status and returns the last verdict. */
function failStreak(ledger: SourceLedger, status: number | "error", n: number): string {
  let verdict = "";
  for (let i = 0; i < n; i += 1) {
    verdict = recordFetch(ledger, {
      source_id: "ucb-05",
      url: URL,
      ok: false,
      status,
      contentHash: null,
      nowIso: `2026-0${i + 1}-01T00:00:00Z`,
    });
  }
  return verdict;
}

test("classifyFailure separates gone from blocked from transient", () => {
  assert.equal(classifyFailure(404), "gone");
  assert.equal(classifyFailure(410), "gone");
  assert.equal(classifyFailure(403), "blocked");
  assert.equal(classifyFailure(401), "blocked");
  assert.equal(classifyFailure(429), "blocked");
  assert.equal(classifyFailure(500), "transient");
  assert.equal(classifyFailure(503), "transient");
  assert.equal(classifyFailure("error"), "transient");
});

test("a 404 streak marks the source dead at DEAD_THRESHOLD", () => {
  const ledger: SourceLedger = {};
  assert.equal(failStreak(ledger, 404, DEAD_THRESHOLD - 1), "transient_failure");
  assert.equal(failStreak(ledger, 404, 1), "dead");
  assert.equal(ledger[KEY].last_status, "dead");
  assert.equal(ledger[KEY].gone_failures, DEAD_THRESHOLD);
});

test("a 403 streak NEVER marks the source dead, however long", () => {
  // The regression this whole distinction exists for: a bot wall used to
  // read as death after two runs and manufacture a `newly_absent` change.
  const ledger: SourceLedger = {};
  const verdict = failStreak(ledger, 403, BLOCKED_REVIEW_THRESHOLD + 4);
  assert.notEqual(verdict, "dead");
  assert.equal(verdict, "blocked");
  assert.notEqual(ledger[KEY].last_status, "dead");
  assert.equal(ledger[KEY].gone_failures, 0);
});

test("a blocked streak surfaces for review at BLOCKED_REVIEW_THRESHOLD", () => {
  const ledger: SourceLedger = {};
  assert.equal(failStreak(ledger, 403, BLOCKED_REVIEW_THRESHOLD - 1), "transient_failure");
  assert.equal(failStreak(ledger, 403, 1), "blocked");
});

test("a 5xx streak is transient forever — never dead, never blocked", () => {
  const ledger: SourceLedger = {};
  const verdict = failStreak(ledger, 503, BLOCKED_REVIEW_THRESHOLD + 4);
  assert.equal(verdict, "transient_failure");
  assert.equal(ledger[KEY].gone_failures, 0);
  assert.equal(ledger[KEY].blocked_failures, 0);
});

test("mixed failure kinds do not compound toward death", () => {
  // 403 then 404 is one not-found, not two steps from the grave.
  const ledger: SourceLedger = {};
  failStreak(ledger, 403, 1);
  const verdict = failStreak(ledger, 404, 1);
  assert.notEqual(verdict, "dead");
  assert.equal(ledger[KEY].gone_failures, 1);
  assert.equal(ledger[KEY].blocked_failures, 0, "the blocked streak resets on a different kind");
  assert.equal(ledger[KEY].consecutive_failures, 2, "overall health streak still counts both");
});

test("last_error_status preserves the code that caused death", () => {
  const ledger: SourceLedger = {};
  failStreak(ledger, 404, DEAD_THRESHOLD);
  assert.equal(ledger[KEY].last_status, "dead", "last_status is overwritten…");
  assert.equal(ledger[KEY].last_error_status, 404, "…but the cause survives");
});

test("a successful fetch clears every failure streak", () => {
  const ledger: SourceLedger = {};
  failStreak(ledger, 403, 3);
  const verdict = recordFetch(ledger, {
    source_id: "ucb-05",
    url: URL,
    ok: true,
    status: 200,
    contentHash: "abc",
    nowIso: "2026-09-01T00:00:00Z",
  });
  assert.equal(verdict, "first_seen");
  assert.equal(ledger[KEY].consecutive_failures, 0);
  assert.equal(ledger[KEY].blocked_failures, 0);
  assert.equal(ledger[KEY].gone_failures, 0);
  assert.equal(ledger[KEY].last_error_status, null);
});

test("entries written before the streak fields existed migrate cleanly", () => {
  // The 36 live `dead` entries have no gone_failures/blocked_failures key.
  const ledger = {
    [KEY]: {
      source_id: "ucb-05",
      url: URL,
      content_hash: null,
      last_fetched: "2026-08-01T00:00:00Z",
      last_status: "dead",
      last_changed: null,
      first_seen: "2026-04-01T00:00:00Z",
      consecutive_failures: 4,
    },
  } as unknown as SourceLedger;

  const verdict = failStreak(ledger, 403, 1);
  assert.equal(verdict, "transient_failure", "a legacy dead entry that 403s is no longer dead");
  assert.equal(ledger[KEY].gone_failures, 0);
  assert.equal(ledger[KEY].last_status, 403);
});
