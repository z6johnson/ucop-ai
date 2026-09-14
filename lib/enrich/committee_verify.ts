/**
 * Committee directory re-verification orchestrator.
 *
 * For each committee member, runs one web_search-grounded Claude call to
 * re-confirm the small allowlist of structured profile facts (title,
 * organization, department, role) and, when materially stale, the synopsis.
 * Proposed values are validated and diffed against the current record, then
 * ALWAYS routed to human review — these are facts about real people, so no
 * committee change is ever auto-applied, regardless of kind.
 *
 * The anti-hallucination source gate is inherently lighter here than for the
 * baseline (the model both searches and cites), so the human-review gate is
 * the real control. That asymmetry is intentional and documented.
 */

import type Anthropic from "@anthropic-ai/sdk";

import { canonicalUrl, isoDateUTC, isoNowUTC } from "../activity.ts";
import type { FieldRecord } from "../baseline.ts";
import { getLiteLLMClient } from "../litellm.ts";
import { partitionSuppressed, readDecisionsLedger } from "./decisions.ts";
import { classify } from "./diff.ts";
import { makeCommitteeAdapter, COMMITTEE_DIMENSION, COMMITTEE_FIELD_ALLOWLIST } from "./targets/committee.ts";
import { validateCandidates } from "./validate.ts";
import {
  type CandidateField,
  type Changeset,
  type EnrichInputsManifest,
  type ProposedChange,
  type SourceSet,
} from "./types.ts";

const MAX_TOOL_USES = 3;

export type CommitteeRunOptions = {
  repoRoot: string;
  runDate: Date;
  model: string;
  lookbackDays: number;
  maxEntities?: number;
};

export type CommitteeRunResult = {
  changeset: Changeset;
  rejected: Array<{ entity_id: string; dimension: string; field: string; reasons: string[]; raw: unknown }>;
  /** Proposals withheld by a standing rejection — see lib/enrich/decisions.ts. */
  suppressed: ProposedChange[];
};

function systemPrompt(): string {
  return `You re-verify the public professional facts of one named member of the UCOP AI Steering Committee. You MUST call web_search at least once before answering, and rely only on what you find on current, credible institutional or press pages.

Only report a field when a live source confirms it AND it differs from, or fills a gap in, the current record provided. Allowed fields (use these exact names):
- primary_affiliation.title   (their current primary job title)
- primary_affiliation.organization
- primary_affiliation.department
- committee_role.role          (one of: co_chair, special_advisor, member, advisory_board, support_team, student_member)
- enrichment.synopsis          (a 3–5 sentence factual summary; only if materially out of date)

Your final message MUST be a single JSON object and nothing else:
{
  "fields": [
    { "field": "primary_affiliation.title", "value": "…", "source_url": "https://…", "notes": "evidence sentence", "confidence": "high" }
  ]
}
If everything in the current record is still accurate, return {"fields": []}. No prose, no code fences.`;
}

function userPrompt(memberName: string, current: Record<string, FieldRecord | null>): string {
  const lines = Object.entries(current)
    .map(([f, rec]) => `- ${f}: ${rec ? JSON.stringify(rec.value) : "(absent)"}`)
    .join("\n");
  return `Member: "${memberName}".

Current record values:
${lines}

Search the public web for this person's CURRENT title, organization, department, and role. Run at least one web_search call. Return strict JSON per the system instructions.`;
}

function extractText(message: Anthropic.Message): string {
  const parts: string[] = [];
  for (const block of message.content) if (block.type === "text") parts.push(block.text);
  return parts.join("\n").trim();
}

function tryParseJson(text: string): { fields?: unknown } | null {
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s) as { fields?: unknown };
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a !== -1 && b > a) {
      try {
        return JSON.parse(s.slice(a, b + 1)) as { fields?: unknown };
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function verifyMember(
  memberId: string,
  memberName: string,
  current: Record<string, FieldRecord | null>,
  model: string,
): Promise<CandidateField[]> {
  let message: Anthropic.Message;
  try {
    message = await getLiteLLMClient().messages.create({
      model,
      max_tokens: 1536,
      system: systemPrompt(),
      messages: [{ role: "user", content: userPrompt(memberName, current) }],
      tool_choice: { type: "any" },
      tools: [
        { type: "web_search_20260209", name: "web_search", max_uses: MAX_TOOL_USES },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ] as any,
    });
  } catch (err) {
    console.warn(`[enrich] committee verify failed ${memberId}: ${(err as Error).message}`);
    return [];
  }

  const allow = new Set<string>(COMMITTEE_FIELD_ALLOWLIST);
  const parsed = tryParseJson(extractText(message));
  const rawList = Array.isArray(parsed?.fields) ? (parsed!.fields as unknown[]) : [];
  const out: CandidateField[] = [];
  for (const raw of rawList) {
    const r = (raw ?? {}) as Record<string, unknown>;
    const field = typeof r.field === "string" ? r.field.trim() : "";
    if (!allow.has(field)) continue;
    const value = typeof r.value === "string" ? r.value : null;
    out.push({
      entity_id: memberId,
      dimension: COMMITTEE_DIMENSION,
      field,
      record: {
        value,
        source_id: typeof r.source_url === "string" ? canonicalUrl(r.source_url) : null,
        source_url: typeof r.source_url === "string" ? r.source_url : null,
        notes: typeof r.notes === "string" ? r.notes : null,
      },
      source_artifact_id: typeof r.source_url === "string" ? r.source_url : "",
      confidence: r.confidence === "high" || r.confidence === "medium" || r.confidence === "low" ? r.confidence : "low",
    });
  }
  return out;
}

export async function runCommitteeEnrichment(opts: CommitteeRunOptions): Promise<CommitteeRunResult> {
  const adapter = makeCommitteeAdapter(opts.repoRoot);
  let memberIds = adapter.entityIds();
  if (opts.maxEntities) memberIds = memberIds.slice(0, opts.maxEntities);

  const runDateIso = isoDateUTC(opts.runDate);
  const allCandidates: CandidateField[] = [];

  for (const memberId of memberIds) {
    const current: Record<string, FieldRecord | null> = {};
    for (const f of COMMITTEE_FIELD_ALLOWLIST) {
      current[f] = adapter.getRecord(memberId, COMMITTEE_DIMENSION, f);
    }
    const cands = await verifyMember(memberId, adapter.entityName(memberId) ?? memberId, current, opts.model);
    allCandidates.push(...cands);
  }

  // The committee source set is the candidates' own cited URLs (the model
  // both searches and cites). The http/notes/coordinate checks still run; the
  // human-review gate is the real control.
  const sourceSet: SourceSet = new Map();
  for (const c of allCandidates) {
    if (c.record.source_url) {
      sourceSet.set(canonicalUrl(c.record.source_url), {
        source_id: c.record.source_id ?? "",
        url: c.record.source_url,
      });
    }
  }

  const validation = validateCandidates(allCandidates, adapter, sourceSet);
  const changes: ProposedChange[] = [];
  for (const cand of validation.accepted) {
    const current = adapter.getRecord(cand.entity_id, cand.dimension, cand.field);
    const change = classify(current, cand);
    change.status = "needs_human"; // committee facts about real people → always reviewed
    changes.push(change);
  }

  const manifest: EnrichInputsManifest = {
    sources_refreshed: 0,
    sources_unchanged: 0,
    sources_changed: 0,
    sources_dead: 0,
    sources_discovered: allCandidates.length,
    entities_swept: memberIds.length,
    dimensions_swept: 1,
  };

  // Hold back anything already declined in identical form (see run.ts).
  const decisionsLedger = readDecisionsLedger(opts.repoRoot);
  const { kept, suppressed } = partitionSuppressed(changes, decisionsLedger, isoNowUTC(opts.runDate));
  manifest.suppressed = suppressed.length;

  const changeset: Changeset = {
    changeset_id: `${runDateIso.slice(0, 7)}-committee`,
    target: "committee",
    run_date: runDateIso,
    status: "draft",
    approval_mode: "human",
    policy_id: "",
    reviewed_by: "",
    reviewed_at: "",
    applied_at: "",
    generated_at: isoNowUTC(opts.runDate),
    generated_by_model: opts.model,
    base_version: adapter.version(),
    target_version: "",
    inputs_manifest: manifest,
    changes: kept,
  };

  return {
    changeset,
    rejected: validation.rejected.map((r) => ({
      entity_id: r.candidate.entity_id,
      dimension: r.candidate.dimension,
      field: r.candidate.field,
      reasons: r.reasons,
      raw: r.candidate,
    })),
    suppressed,
  };
}
