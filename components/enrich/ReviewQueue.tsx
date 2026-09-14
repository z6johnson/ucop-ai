"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Decision } from "@/lib/enrich/changeset-format";
import {
  UNGROUPED,
  facets,
  filterChanges,
  groupByDeadSource,
  queueCounts,
  type QueueFilter,
  type ReviewChange,
} from "@/lib/enrich/review";
import { ChangeCard } from "./ChangeCard";
import { PublishPanel } from "./PublishPanel";

type Status = "idle" | "saving" | "saved" | "conflict" | "error";

export type ReviewQueueProps = {
  changesetId: string;
  changes: ReviewChange[];
  initialDecisions: Record<string, Decision>;
  initialSha: string | null;
  entityNames: Record<string, string>;
  dimensionLabels: Record<string, string>;
  readOnly?: boolean;
  /** Publish affordance — omitted for read-only lanes. */
  publish?: { targetLabel: string; baseVersion: string };
};

const ALL: QueueFilter = {
  kind: "all",
  confidence: "all",
  dimension: "all",
  entity: "all",
  decision: "all",
  search: "",
};

export function ReviewQueue({
  changesetId,
  changes,
  initialDecisions,
  initialSha,
  entityNames,
  dimensionLabels,
  readOnly = false,
  publish,
}: ReviewQueueProps) {
  // `saved` is what is on the server; `overlay` is what the reviewer has done
  // since. Keeping them apart is what lets Save send just the diff, and what
  // makes the dirty count meaningful.
  const [saved, setSaved] = useState<Record<string, Decision>>(initialDecisions);
  const [overlay, setOverlay] = useState<Record<string, Decision>>({});
  const [sha, setSha] = useState<string | null>(initialSha);
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<QueueFilter>(ALL);
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  const decisions = useMemo(() => ({ ...saved, ...overlay }), [saved, overlay]);
  const dirty = Object.keys(overlay).length;
  const visible = useMemo(
    () => filterChanges(changes, filter, decisions),
    [changes, filter, decisions],
  );
  const counts = useMemo(() => queueCounts(changes, decisions), [changes, decisions]);
  const f = useMemo(() => facets(changes), [changes]);
  const groups = useMemo(() => groupByDeadSource(visible), [visible]);

  const decide = useCallback(
    (ids: string[], d: Decision) => {
      if (readOnly) return;
      setOverlay((prev) => {
        const next = { ...prev };
        for (const id of ids) {
          // Setting a value back to what the server already has is not a change.
          if (saved[id] === d) delete next[id];
          else next[id] = d;
        }
        return next;
      });
      setStatus("idle");
    },
    [readOnly, saved],
  );

  /* ---------------- Save ---------------- */

  const save = useCallback(async () => {
    if (readOnly || dirty === 0 || status === "saving") return;
    setStatus("saving");
    setMessage("");
    try {
      const res = await fetch(`/api/enrich/${changesetId}/decisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseSha: sha, decisions: overlay }),
      });
      const data = (await res.json()) as {
        error?: string;
        conflict?: boolean;
        sha?: string;
        rejected?: string[];
      };
      if (!res.ok) {
        setStatus(data.conflict ? "conflict" : "error");
        setMessage(data.error ?? "Could not save.");
        return;
      }
      // Fold the overlay into the saved baseline; nothing is dirty any more.
      setSaved((prev) => ({ ...prev, ...overlay }));
      setOverlay({});
      if (data.sha) setSha(data.sha);
      setStatus("saved");
      setMessage(`Saved ${dirty} decision${dirty === 1 ? "" : "s"}.`);
    } catch {
      setStatus("error");
      setMessage("Network error — your decisions are still here, try again.");
    }
  }, [changesetId, dirty, overlay, readOnly, sha, status]);

  /* ---------------- Keyboard ---------------- */

  useEffect(() => {
    if (readOnly) return;
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select")) return;

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      const current = visible[cursor];
      switch (e.key.toLowerCase()) {
        case "j":
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, visible.length - 1));
          break;
        case "k":
          e.preventDefault();
          setCursor((c) => Math.max(c - 1, 0));
          break;
        case "a":
          if (!current) return;
          e.preventDefault();
          decide([current.id], "accept");
          setCursor((c) => Math.min(c + 1, visible.length - 1));
          break;
        case "r":
          if (!current) return;
          e.preventDefault();
          decide([current.id], "reject");
          setCursor((c) => Math.min(c + 1, visible.length - 1));
          break;
        case "s":
          e.preventDefault();
          setCursor((c) => Math.min(c + 1, visible.length - 1));
          break;
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursor, decide, readOnly, save, visible]);

  // Keep the focused card on screen when moving by keyboard.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // Reset the cursor when the visible set changes out from under it.
  useEffect(() => {
    setCursor((c) => Math.min(c, Math.max(visible.length - 1, 0)));
  }, [visible.length]);

  /* ---------------- Unsaved-work guard ---------------- */

  useEffect(() => {
    if (dirty === 0) return;
    function warn(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  /* ---------------- Render ---------------- */

  const statusColor =
    status === "conflict" || status === "error"
      ? "var(--color-danger)"
      : status === "saved"
        ? "var(--color-accent)"
        : "var(--color-text-subtle)";

  return (
    <div>
      <div
        className="sticky top-0 z-10 -mx-2 mb-2 px-2 py-3"
        style={{ background: "var(--color-surface, #fff)" }}
      >
        <div className="hairline flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 pb-3">
          <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
            <strong style={{ color: "var(--color-accent)" }}>{counts.accept}</strong> approved ·{" "}
            <strong>{counts.reject}</strong> declined ·{" "}
            <strong style={{ color: counts.review > 0 ? "var(--color-warn-strong)" : undefined }}>
              {counts.review}
            </strong>{" "}
            undecided <span style={{ color: "var(--color-text-subtle)" }}>of {counts.total}</span>
          </p>

          {!readOnly ? (
            <div className="flex items-center gap-3">
              {message ? (
                <span className="label" style={{ color: statusColor }}>
                  {message}
                </span>
              ) : null}
              <button
                type="button"
                onClick={() => void save()}
                disabled={dirty === 0 || status === "saving"}
                className="label rounded px-4 py-2 disabled:opacity-40"
                style={{
                  background: dirty > 0 ? "var(--color-accent)" : "transparent",
                  color: dirty > 0 ? "var(--color-surface)" : "var(--color-text-subtle)",
                  border: "1px solid var(--color-accent)",
                  cursor: dirty === 0 ? "not-allowed" : "pointer",
                }}
              >
                {status === "saving" ? "Saving…" : dirty > 0 ? `Save ${dirty}` : "Saved"}
              </button>
            </div>
          ) : null}
        </div>

        {status === "conflict" ? (
          <p className="mt-2 text-sm" style={{ color: "var(--color-danger)" }}>
            {message}{" "}
            <button
              type="button"
              onClick={() => window.location.reload()}
              style={{ color: "var(--color-accent)", textDecoration: "underline", cursor: "pointer" }}
            >
              Reload
            </button>
          </p>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={filter.search ?? ""}
            onChange={(e) => setFilter((p) => ({ ...p, search: e.target.value }))}
            placeholder="Search entity, field, notes…"
            className="ucnfi-input text-sm"
            style={{ minWidth: "16rem" }}
          />
          <Select
            value={filter.decision ?? "all"}
            onChange={(v) => setFilter((p) => ({ ...p, decision: v as QueueFilter["decision"] }))}
            options={[
              ["all", "All decisions"],
              ["undecided", "Undecided only"],
              ["accept", "Approved"],
              ["reject", "Declined"],
            ]}
          />
          <Select
            value={filter.kind ?? "all"}
            onChange={(v) => setFilter((p) => ({ ...p, kind: v as QueueFilter["kind"] }))}
            options={[["all", "All kinds"], ...f.kinds.map((k) => [k, k.replace(/_/g, " ")] as [string, string])]}
          />
          <Select
            value={filter.confidence ?? "all"}
            onChange={(v) => setFilter((p) => ({ ...p, confidence: v as QueueFilter["confidence"] }))}
            options={[["all", "Any confidence"], ...f.confidences.map((c) => [c, c] as [string, string])]}
          />
          <Select
            value={filter.dimension ?? "all"}
            onChange={(v) => setFilter((p) => ({ ...p, dimension: v }))}
            options={[
              ["all", "All dimensions"],
              ...f.dimensions.map((d) => [d, dimensionLabels[d] ?? d] as [string, string]),
            ]}
          />
          {JSON.stringify(filter) !== JSON.stringify(ALL) ? (
            <button
              type="button"
              onClick={() => setFilter(ALL)}
              className="label"
              style={{ color: "var(--color-accent)", cursor: "pointer" }}
            >
              clear filters
            </button>
          ) : null}
        </div>

        {!readOnly && visible.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="label" style={{ color: "var(--color-text-subtle)" }}>
              {visible.length} shown
            </span>
            <BulkButton onClick={() => decide(visible.map((c) => c.id), "accept")}>
              Approve all shown
            </BulkButton>
            <BulkButton onClick={() => decide(visible.map((c) => c.id), "reject")}>
              Decline all shown
            </BulkButton>
            <span className="label" style={{ color: "var(--color-text-subtle)" }}>
              a approve · r decline · s skip · j/k move · ⌘S save
            </span>
          </div>
        ) : null}
      </div>

      {visible.length === 0 ? (
        <p className="mt-8 text-sm" style={{ color: "var(--color-text-subtle)" }}>
          Nothing matches these filters.
        </p>
      ) : null}

      <ul ref={listRef} className="flex flex-col">
        {[...groups.entries()].map(([groupKey, items]) => {
          const isDeadSourceGroup = groupKey !== UNGROUPED && items.length > 1;
          return (
            <li key={groupKey}>
              {isDeadSourceGroup ? (
                <div
                  className="mt-6 flex flex-wrap items-baseline justify-between gap-2 rounded px-3 py-2"
                  style={{ background: "var(--color-surface-muted, rgba(0,0,0,0.04))" }}
                >
                  <p className="text-sm" style={{ color: "var(--color-text-muted)" }}>
                    <strong>{items.length} fields</strong> rest on one source that stopped
                    resolving — <code>{groupKey}</code>. One call covers all of them.
                  </p>
                  {!readOnly ? (
                    <div className="flex gap-2">
                      <BulkButton onClick={() => decide(items.map((c) => c.id), "accept")}>
                        Approve group
                      </BulkButton>
                      <BulkButton onClick={() => decide(items.map((c) => c.id), "reject")}>
                        Decline group
                      </BulkButton>
                    </div>
                  ) : null}
                </div>
              ) : null}
              <ul className="flex flex-col">
                {items.map((c) => {
                  const idx = visible.indexOf(c);
                  return (
                    <div key={c.id} data-idx={idx}>
                      <ChangeCard
                        change={c}
                        decision={decisions[c.id] ?? "review"}
                        entityName={entityNames[c.entity_id] ?? c.entity_id}
                        dimensionLabel={dimensionLabels[c.dimension] ?? c.dimension}
                        onDecide={(d) => {
                          decide([c.id], d);
                          setCursor(idx);
                        }}
                        readOnly={readOnly}
                        focused={idx === cursor}
                      />
                    </div>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

      {!readOnly && publish ? (
        <>
          {dirty > 0 ? (
            <p className="mt-8 text-sm" style={{ color: "var(--color-warn-strong)" }}>
              {dirty} decision{dirty === 1 ? "" : "s"} not yet saved — publishing will
              include {dirty === 1 ? "it" : "them"}.
            </p>
          ) : null}
          <PublishPanel
            changesetId={changesetId}
            acceptedCount={counts.accept}
            totalCount={counts.total}
            undecidedCount={counts.review}
            sha={sha}
            pendingDecisions={overlay}
            targetLabel={publish.targetLabel}
            baseVersion={publish.baseVersion}
          />
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function BulkButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="label rounded px-3 py-1"
      style={{
        border: "1px solid var(--color-border, rgba(0,0,0,0.15))",
        color: "var(--color-text-muted)",
        cursor: "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="ucnfi-input text-sm"
      style={{ cursor: "pointer" }}
    >
      {options.map(([v, label]) => (
        <option key={v} value={v}>
          {label}
        </option>
      ))}
    </select>
  );
}
