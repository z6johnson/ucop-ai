/**
 * Monthly enrichment orchestrator for the FieldRecord targets (UC baseline
 * and peer baseline). Ties the stages together and returns a draft changeset
 * + rejection record; the calling script writes them.
 *
 * Stages:
 *  (a) refresh known sources → freshness ledger (changed / dead detection)
 *  (b) full discovery sweep (entity × all 10 dimensions) via web_search
 *  (c) LLM extraction of candidate fields for active cells
 *  (d) validate (anti-hallucination gate) + diff/classify
 *      + deterministic newly_absent changes for dead sources
 *  (e) assemble the draft changeset (status: draft, reviewed_by empty)
 *
 * The committee target has its own orchestrator (committee_verify.ts).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalUrl, isoDateUTC, isoNowUTC } from "../activity.ts";
import type { FieldRecord } from "../baseline.ts";
import { discoverSources } from "./discover.ts";
import { classify } from "./diff.ts";
import { extractCandidates, type SourceForExtract } from "./extract.ts";
import { partitionSuppressed, readDecisionsLedger } from "./decisions.ts";
import { fetchSource } from "./fetch.ts";
import { allInventorySources, inventoryByEntity } from "./inventory.ts";
import {
  BLOCKED_REVIEW_THRESHOLD,
  DEAD_THRESHOLD,
  pruneLedger,
  readLedger,
  recordFetch,
  writeLedger,
  type FreshnessVerdict,
} from "./ledger.ts";
import { makeAdapter } from "./targets/index.ts";
import { BASELINE_FILE } from "./targets/baseline.ts";
import { PEER_FILE } from "./targets/peer.ts";
import { validateCandidates } from "./validate.ts";
import {
  changeId,
  type Changeset,
  type DiscoveredArtifact,
  type EnrichInputsManifest,
  type EnrichTarget,
  type ProposedChange,
  type SourceSet,
} from "./types.ts";

export type RunOptions = {
  repoRoot: string;
  target: Extract<EnrichTarget, "baseline" | "peer">;
  runDate: Date;
  model: string;
  lookbackDays: number;
  /** Full entity×dimension discovery sweep (default). If false, only cells
   * touched by a changed source are extracted. */
  fullSweep: boolean;
  /** Optional cap on entities processed (for cheap smoke runs). */
  maxEntities?: number;
  /** When true, do not persist the source-freshness ledger (dry run). */
  dryRun?: boolean;
};

export type RunResult = {
  changeset: Changeset;
  rejected: Array<{ entity_id: string; dimension: string; field: string; reasons: string[]; raw: unknown }>;
  /** Proposals withheld by a standing rejection — see lib/enrich/decisions.ts. */
  suppressed: ProposedChange[];
};

type RawFieldFile = {
  metadata: { version: string };
  schema: { dimensions: Record<string, string> };
  entities: Record<string, { entity_name?: string } & Record<string, unknown>>;
};

function loadFieldFile(repoRoot: string, target: "baseline" | "peer"): RawFieldFile {
  const fileName = target === "baseline" ? BASELINE_FILE : PEER_FILE;
  return JSON.parse(readFileSync(join(repoRoot, "data", fileName), "utf-8")) as RawFieldFile;
}

/** field → FieldRecord for one entity×dimension. */
function sliceOf(entity: Record<string, unknown>, dimension: string): Record<string, FieldRecord> {
  const bucket = entity[dimension];
  return bucket && typeof bucket === "object" ? (bucket as Record<string, FieldRecord>) : {};
}

export async function runFieldEnrichment(opts: RunOptions): Promise<RunResult> {
  const { repoRoot, target, runDate } = opts;
  const file = loadFieldFile(repoRoot, target);
  const dimensions = Object.keys(file.schema.dimensions);
  const adapter = makeAdapter(target, repoRoot);
  const ledger = readLedger(repoRoot);
  const runDateIso = isoDateUTC(runDate);
  const nowIso = isoNowUTC(runDate);

  let entityIds = Object.keys(file.entities);
  if (opts.maxEntities) entityIds = entityIds.slice(0, opts.maxEntities);

  // ---- Known sources: inventory (baseline) + every current field's URL. ----
  const inventoryForEntity =
    target === "baseline" ? inventoryByEntity(repoRoot).byEntity : new Map();

  // url → list of fields it currently backs (for change + dead routing).
  type Backed = { entity_id: string; dimension: string; field: string; record: FieldRecord };
  const urlToBacked = new Map<string, Backed[]>();
  const knownUrlsByEntity = new Map<string, Set<string>>();
  for (const eid of entityIds) {
    const ent = file.entities[eid];
    const known = new Set<string>();
    for (const dim of dimensions) {
      for (const [field, rec] of Object.entries(sliceOf(ent, dim))) {
        if (rec.source_url) {
          const cu = canonicalUrl(rec.source_url);
          known.add(cu);
          const list = urlToBacked.get(cu) ?? [];
          list.push({ entity_id: eid, dimension: dim, field, record: rec });
          urlToBacked.set(cu, list);
        }
      }
    }
    for (const s of inventoryForEntity.get(eid) ?? []) known.add(canonicalUrl(s.url));
    knownUrlsByEntity.set(eid, known);
  }

  // field name hints per dimension (across all entities).
  const fieldHints = new Map<string, Set<string>>();
  for (const eid of entityIds) {
    for (const dim of dimensions) {
      const set = fieldHints.get(dim) ?? new Set<string>();
      for (const f of Object.keys(sliceOf(file.entities[eid], dim))) set.add(f);
      fieldHints.set(dim, set);
    }
  }

  // ---- (a) Refresh known sources. ----
  const manifest: EnrichInputsManifest = {
    sources_refreshed: 0,
    sources_unchanged: 0,
    sources_changed: 0,
    sources_dead: 0,
    sources_blocked: 0,
    sources_discovered: 0,
    entities_swept: entityIds.length,
    dimensions_swept: dimensions.length,
    suppressed: 0,
  };

  // Collect the union of sources to refresh: inventory (baseline) + current urls.
  const toRefresh = new Map<string, { source_id: string; url: string; type: "pdf" | "web" }>();
  if (target === "baseline") {
    for (const s of allInventorySources(repoRoot)) {
      toRefresh.set(canonicalUrl(s.url), { source_id: s.id, url: s.url, type: s.type });
    }
  }
  for (const [cu, backed] of urlToBacked) {
    if (!toRefresh.has(cu)) {
      const sid = backed[0]?.record.source_id ?? "current";
      toRefresh.set(cu, { source_id: sid, url: cu, type: cu.toLowerCase().endsWith(".pdf") ? "pdf" : "web" });
    }
  }

  // changed source url → fetched body excerpt (for extraction grounding).
  const changedBodies = new Map<string, string>();
  const deadUrls: Array<{ url: string; source_id: string }> = [];

  for (const [cu, src] of toRefresh) {
    const outcome = await fetchSource(src);
    manifest.sources_refreshed += 1;
    const verdict: FreshnessVerdict = recordFetch(ledger, {
      source_id: src.source_id,
      url: src.url,
      ok: outcome.ok,
      status: outcome.status,
      contentHash: outcome.contentHash,
      nowIso,
    });
    if (verdict === "unchanged" || verdict === "first_seen") manifest.sources_unchanged += 1;
    else if (verdict === "changed") {
      manifest.sources_changed += 1;
      changedBodies.set(cu, outcome.body ?? "");
    } else if (verdict === "dead") {
      manifest.sources_dead += 1;
      deadUrls.push({ url: cu, source_id: src.source_id });
    } else if (verdict === "blocked") {
      // Persistently refused by a bot wall. Counted and logged so it can be
      // checked by hand, but it produces no change — being unable to read a
      // page says nothing about what the page says.
      manifest.sources_blocked = (manifest.sources_blocked ?? 0) + 1;
      console.warn(
        `[enrich] source ${src.source_id} blocked (HTTP ${outcome.status}) for ` +
          `${BLOCKED_REVIEW_THRESHOLD}+ consecutive checks — verify by hand: ${src.url}`,
      );
    }
  }

  // ---- (b) Discovery sweep + (c) extraction, per entity×dimension. ----
  const allCandidates: import("./types.ts").CandidateField[] = [];
  const sourceSet: SourceSet = new Map();

  for (const eid of entityIds) {
    const ent = file.entities[eid];
    const entityName = (ent.entity_name as string) ?? eid;
    const known = knownUrlsByEntity.get(eid) ?? new Set<string>();

    for (const dim of dimensions) {
      // Discovery.
      let discovered: DiscoveredArtifact[] = [];
      if (opts.fullSweep) {
        discovered = await discoverSources({
          entityId: eid,
          entityName,
          dimension: dim,
          dimensionDescription: file.schema.dimensions[dim] ?? dim,
          knownUrls: [...known],
          lookbackDays: opts.lookbackDays,
        });
        manifest.sources_discovered += discovered.length;
      }

      // Changed sources that currently back a field in THIS cell.
      const changedForCell: SourceForExtract[] = [];
      for (const [cu, body] of changedBodies) {
        const backed = (urlToBacked.get(cu) ?? []).filter(
          (b) => b.entity_id === eid && b.dimension === dim,
        );
        if (backed.length > 0) {
          changedForCell.push({
            source_id: backed[0].record.source_id ?? "current",
            title: backed[0].field,
            url: cu,
            issuer: "",
            published_at: null,
            excerpt: body.slice(0, 1500),
          });
        }
      }

      const sourcesForCell: SourceForExtract[] = [
        ...discovered.map((d) => ({
          source_id: d.source_id,
          title: d.title,
          url: d.url,
          issuer: d.issuer,
          published_at: d.published_at,
          excerpt: d.snippet,
        })),
        ...changedForCell,
      ];

      if (sourcesForCell.length === 0) continue; // empty-input short-circuit

      // Register every provided source in the run's source set (anti-hallucination).
      for (const s of sourcesForCell) sourceSet.set(canonicalUrl(s.url), { source_id: s.source_id, url: s.url });

      const candidates = await extractCandidates({
        entityId: eid,
        entityName,
        dimension: dim,
        dimensionDescription: file.schema.dimensions[dim] ?? dim,
        currentSlice: sliceOf(ent, dim),
        sources: sourcesForCell,
        fieldNameHints: [...(fieldHints.get(dim) ?? new Set())],
      });
      allCandidates.push(...candidates);
    }
  }

  // ---- (d) Validate + diff. ----
  const validation = validateCandidates(allCandidates, adapter, sourceSet);
  const changes: ProposedChange[] = [];
  for (const cand of validation.accepted) {
    const current = adapter.getRecord(cand.entity_id, cand.dimension, cand.field);
    changes.push(classify(current, cand));
  }

  // Deterministic newly_absent changes for dead sources (no model involved →
  // bypass the candidate validator; these aren't hallucinations).
  for (const dead of deadUrls) {
    for (const backed of urlToBacked.get(dead.url) ?? []) {
      if (backed.record.value === false || backed.record.value === null) continue;
      const change: ProposedChange = {
        entity_id: backed.entity_id,
        dimension: backed.dimension,
        field: backed.field,
        record: {
          value: false,
          source_id: "inventory-gap",
          source_url: null,
          notes: `Backing source ${dead.source_id} (${dead.url}) returned HTTP 404/410 for ≥${DEAD_THRESHOLD} consecutive monthly checks; the prior positive assertion is no longer publicly verifiable. Recorded as a gap for committee attention.`,
        },
        source_artifact_id: "inventory-gap",
        confidence: "medium",
        change_kind: "newly_absent",
        current_record: backed.record,
        status: "needs_human",
        validation_reasons: [],
      };
      changes.push(change);
    }
  }

  // ---- (e) Assemble the draft changeset. ----
  const changesetId =
    target === "baseline" ? runDateIso.slice(0, 7) : `${runDateIso.slice(0, 7)}-${target}`;

  // Hold back anything the reviewer already declined in identical form. This
  // is what stops the queue re-presenting last quarter's decisions; the
  // withheld set is returned so the caller can write the audit sidecar.
  const decisionsLedger = readDecisionsLedger(repoRoot);
  const { kept, suppressed } = partitionSuppressed(
    dedupeChanges(changes),
    decisionsLedger,
    nowIso,
  );
  manifest.suppressed = suppressed.length;

  const changeset: Changeset = {
    changeset_id: changesetId,
    target,
    run_date: runDateIso,
    status: "draft",
    approval_mode: "human",
    policy_id: "",
    reviewed_by: "",
    reviewed_at: "",
    applied_at: "",
    generated_at: nowIso,
    generated_by_model: opts.model,
    base_version: file.metadata.version,
    target_version: "",
    inputs_manifest: manifest,
    changes: kept,
  };

  pruneLedger(ledger, 120);
  // The ledger is a real side effect; a dry run must leave the tree clean.
  if (!opts.dryRun) writeLedger(repoRoot, ledger);

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

/** Last write wins per coordinate, so duplicate proposals collapse. */
function dedupeChanges(changes: ProposedChange[]): ProposedChange[] {
  const byId = new Map<string, ProposedChange>();
  for (const c of changes) byId.set(changeId(c), c);
  return [...byId.values()];
}
