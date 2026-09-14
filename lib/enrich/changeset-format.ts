/**
 * The changeset file format — parse, serialize, and reviewer edits.
 *
 * Split out of storage.ts so it can be imported anywhere: this module touches
 * no node builtins, so the review UI can share exactly the code the CLI uses
 * rather than reimplementing the format in the browser.
 *
 * A changeset lives at data/enrich/changesets/{changeset_id}.md and — like a
 * Brief edition — has JSON frontmatter (unambiguous nested change data) plus
 * a markdown body the reviewer reads and annotates:
 *
 *   ---
 *   { ...ChangesetMeta + changes + decisions as JSON... }
 *   ---
 *
 *   ## uc_merced.governance.has_ai_council — new_field
 *   - value: true
 *   - current: (none)
 *   - source: disc-uc_merced-1 (https://…)
 *   - confidence: high
 *   - status: accepted
 *   - notes: UC Merced AI Advisory Council formed 2026-02-11 …
 *   - DECISION: accept
 *
 * Body DECISIONs override the frontmatter defaults on parse, so hand-editing
 * the markdown still works and stays the format's source of truth. The review
 * UI writes through the same path — applyReview regenerates both halves from
 * one decision map, so the two can never disagree.
 *
 * Rejected candidates never appear here; they go to {id}.rejected.json.
 * Proposals withheld by a standing rejection go to {id}.suppressed.json.
 */

import { changeId, type Changeset, type ChangesetMeta, type ProposedChange } from "./types.ts";

export type Decision = "accept" | "reject" | "review";

export const DECISIONS: readonly Decision[] = ["accept", "reject", "review"] as const;

export function isDecision(v: unknown): v is Decision {
  return typeof v === "string" && (DECISIONS as readonly string[]).includes(v);
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

/**
 * Repo-relative POSIX path to a changeset, for the GitHub Contents API.
 * storage.ts has changesetPath() for the absolute on-disk equivalent.
 */
export function changesetRepoPath(changesetId: string): string {
  return `data/enrich/changesets/${changesetId}.md`;
}

/**
 * Changeset ids reach the filesystem, the GitHub API, and a workflow input,
 * so they are validated against a closed shape rather than sanitized.
 */
const CHANGESET_ID_PATTERN = /^\d{4}-\d{2}(-(peer|committee))?(-auto)?$/;

export function isValidChangesetId(id: string): boolean {
  return CHANGESET_ID_PATTERN.test(id);
}

/* ------------------------------------------------------------------ */
/* Frontmatter                                                         */
/* ------------------------------------------------------------------ */

type FrontmatterShape = ChangesetMeta & {
  changes: Record<string, ProposedChange>;
  decisions: Record<string, Decision>;
};

const FENCE = "---";

/** Default decision for a freshly-generated change, from its status. */
export function defaultDecision(change: ProposedChange): Decision {
  if (change.status === "accepted") return "accept";
  if (change.status === "rejected") return "reject";
  return "review";
}

/* ------------------------------------------------------------------ */
/* Serialization                                                       */
/* ------------------------------------------------------------------ */

function fmtValue(v: unknown): string {
  return JSON.stringify(v);
}

/**
 * Collapses newlines in free text before it goes into the markdown body.
 *
 * The body is line-oriented and parseBodyDecisions matches `- DECISION:` at
 * the start of a line, so a note containing a literal newline followed by
 * "- DECISION: accept" would silently set the decision for its own change on
 * the next parse. Notes are model-authored, so that is reachable input, not a
 * hypothetical. The frontmatter keeps the note verbatim; only the rendered
 * body is flattened.
 */
function sanitizeLine(text: string): string {
  return text.replace(/\r?\n/g, " ");
}

export function serializeChangeset(
  changeset: Changeset,
  decisions?: Record<string, Decision>,
): string {
  const changesMap: Record<string, ProposedChange> = {};
  const decisionMap: Record<string, Decision> = {};
  for (const change of changeset.changes) {
    const id = changeId(change);
    changesMap[id] = change;
    decisionMap[id] = decisions?.[id] ?? defaultDecision(change);
  }

  const fm: FrontmatterShape = {
    changeset_id: changeset.changeset_id,
    target: changeset.target,
    run_date: changeset.run_date,
    status: changeset.status,
    approval_mode: changeset.approval_mode,
    policy_id: changeset.policy_id,
    reviewed_by: changeset.reviewed_by,
    reviewed_at: changeset.reviewed_at,
    applied_at: changeset.applied_at,
    generated_at: changeset.generated_at,
    generated_by_model: changeset.generated_by_model,
    base_version: changeset.base_version,
    target_version: changeset.target_version,
    inputs_manifest: changeset.inputs_manifest,
    changes: changesMap,
    decisions: decisionMap,
  };

  const body: string[] = [];
  const howToReview =
    changeset.approval_mode === "policy"
      ? `Applied by policy \`${changeset.policy_id}\` without human sign-off — ` +
        `this file is the audit record of what landed unattended.`
      : `Review at /admin/enrich/${changeset.changeset_id}, or edit each ` +
        `\`DECISION:\` line (accept | reject | review) and set ` +
        `\`reviewed_by\`/\`reviewed_at\` in the frontmatter by hand.`;

  body.push(
    `# Proposed changes — ${changeset.target} — ${changeset.changeset_id}`,
    "",
    `Generated ${changeset.generated_at} by ${changeset.generated_by_model}. ` +
      `Status: **${changeset.status}**. ${howToReview}`,
    "",
  );
  for (const change of changeset.changes) {
    const id = changeId(change);
    body.push(`## ${id} — ${change.change_kind}`);
    body.push(`- value: ${fmtValue(change.record.value)}`);
    body.push(
      `- current: ${change.current_record ? fmtValue(change.current_record.value) : "(none)"}`,
    );
    body.push(`- source: ${change.record.source_id} (${change.record.source_url ?? "—"})`);
    body.push(`- confidence: ${change.confidence}`);
    body.push(`- status: ${change.status}`);
    if (change.validation_reasons.length > 0) {
      body.push(`- flags: ${sanitizeLine(change.validation_reasons.join("; "))}`);
    }
    body.push(`- notes: ${sanitizeLine(change.record.notes ?? "")}`);
    body.push(`- DECISION: ${decisionMap[id]}`);
    body.push("");
  }

  return `${FENCE}\n${JSON.stringify(fm, null, 2)}\n${FENCE}\n\n${body.join("\n")}`;
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

export class ChangesetParseError extends Error {}

function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith(FENCE)) {
    throw new ChangesetParseError("Changeset must start with `---` frontmatter fence");
  }
  const afterOpen = text.indexOf("\n", FENCE.length);
  if (afterOpen === -1) throw new ChangesetParseError("Truncated after opening fence");
  const closeIdx = text.indexOf(`\n${FENCE}`, afterOpen);
  if (closeIdx === -1) throw new ChangesetParseError("Missing closing `---` fence");
  const frontmatter = text.slice(afterOpen + 1, closeIdx).trim();
  let bodyStart = closeIdx + 1 + FENCE.length;
  while (text[bodyStart] === "\n" || text[bodyStart] === "\r") bodyStart += 1;
  return { frontmatter, body: text.slice(bodyStart) };
}

/** Reads `DECISION:` lines from the body, keyed by the preceding `## <id>` heading. */
function parseBodyDecisions(body: string): Record<string, Decision> {
  const out: Record<string, Decision> = {};
  let currentId: string | null = null;
  for (const line of body.split("\n")) {
    const head = /^##\s+([A-Za-z0-9_.-]+)\s+—/.exec(line);
    if (head) {
      currentId = head[1];
      continue;
    }
    const dec = /^-\s*DECISION:\s*(accept|reject|review)\s*$/i.exec(line);
    if (dec && currentId) {
      out[currentId] = dec[1].toLowerCase() as Decision;
    }
  }
  return out;
}

export type ParsedChangeset = {
  changeset: Changeset;
  /** Final per-change decisions, body overriding frontmatter defaults. */
  decisions: Record<string, Decision>;
};

export function parseChangeset(text: string): ParsedChangeset {
  const { frontmatter, body } = splitFrontmatter(text);
  let fm: FrontmatterShape;
  try {
    fm = JSON.parse(frontmatter) as FrontmatterShape;
  } catch (err) {
    throw new ChangesetParseError(`Frontmatter JSON parse failed: ${(err as Error).message}`);
  }

  const changes = Object.values(fm.changes ?? {});
  const decisions: Record<string, Decision> = { ...(fm.decisions ?? {}) };
  // Body DECISIONs are the human's edits and take precedence.
  for (const [id, d] of Object.entries(parseBodyDecisions(body))) decisions[id] = d;

  const changeset: Changeset = {
    changeset_id: fm.changeset_id,
    target: fm.target,
    run_date: fm.run_date,
    status: fm.status,
    // Changesets written before the two lanes existed are human-reviewed by
    // definition — that was the only path that could apply them.
    approval_mode: fm.approval_mode ?? "human",
    policy_id: fm.policy_id ?? "",
    reviewed_by: fm.reviewed_by ?? "",
    reviewed_at: fm.reviewed_at ?? "",
    applied_at: fm.applied_at ?? "",
    generated_at: fm.generated_at,
    generated_by_model: fm.generated_by_model,
    base_version: fm.base_version,
    target_version: fm.target_version ?? "",
    inputs_manifest: fm.inputs_manifest,
    changes,
  };
  return { changeset, decisions };
}

/* ------------------------------------------------------------------ */
/* Reviewer edits                                                      */
/* ------------------------------------------------------------------ */

export type MergeResult = {
  merged: Record<string, Decision>;
  /** Keys from the overlay that name no change in this changeset, or aren't decisions. */
  rejected: string[];
};

/**
 * Folds a reviewer's decisions over the existing map, dropping anything that
 * doesn't correspond to a real change in this changeset. The route reports
 * `rejected` as a 400 rather than silently ignoring it — a decision that
 * doesn't land is worse than an error, because the reviewer believes they
 * decided.
 */
export function mergeDecisions(
  current: Record<string, Decision>,
  overlay: Record<string, unknown>,
  validIds: Set<string>,
): MergeResult {
  const merged: Record<string, Decision> = { ...current };
  const rejected: string[] = [];
  for (const [id, value] of Object.entries(overlay)) {
    if (!validIds.has(id) || !isDecision(value)) {
      rejected.push(id);
      continue;
    }
    merged[id] = value;
  }
  return { merged, rejected };
}

/**
 * Produces the new file text for a reviewed changeset: decisions folded in,
 * sign-off stamped, everything else untouched.
 *
 * Regenerating from the parsed structure rather than patching lines is what
 * keeps the frontmatter decisions map and the body DECISION lines in step.
 */
export function applyReview(
  parsed: ParsedChangeset,
  opts: {
    overlay?: Record<string, Decision>;
    reviewedBy?: string;
    reviewedAt?: string;
  } = {},
): string {
  const changeset: Changeset = { ...parsed.changeset };
  if (opts.reviewedBy !== undefined) changeset.reviewed_by = opts.reviewedBy;
  if (opts.reviewedAt !== undefined) changeset.reviewed_at = opts.reviewedAt;
  const decisions = { ...parsed.decisions, ...(opts.overlay ?? {}) };
  return serializeChangeset(changeset, decisions);
}
