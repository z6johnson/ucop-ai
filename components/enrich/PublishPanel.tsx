"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Phase = "idle" | "publishing" | "running" | "applied" | "failed" | "error";

type StatusResponse = {
  changesetStatus?: string;
  appliedAt?: string;
  targetVersion?: string;
  run?: { status: string; conclusion: string | null; html_url: string } | null;
};

const POLL_INTERVAL_MS = 5_000;
// npm ci + validate + apply + compute_derived + push runs 2-4 minutes.
const MAX_POLLS = 60;
const NAME_KEY = "ucnfi.reviewer";

export function PublishPanel({
  changesetId,
  acceptedCount,
  totalCount,
  undecidedCount,
  sha,
  pendingDecisions,
  targetLabel,
  baseVersion,
}: {
  changesetId: string;
  acceptedCount: number;
  totalCount: number;
  undecidedCount: number;
  sha: string | null;
  /** Unsaved decisions, sent with the publish so nothing is lost. */
  pendingDecisions: Record<string, string>;
  targetLabel: string;
  baseVersion: string;
}) {
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [runUrl, setRunUrl] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const polls = useRef(0);

  useEffect(() => {
    try {
      setName(window.localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      // Private mode — the reviewer just retypes their name.
    }
  }, []);

  /* ---------------- Poll ---------------- */

  const poll = useCallback(
    async (since: string) => {
      polls.current += 1;
      try {
        const res = await fetch(
          `/api/enrich/${changesetId}/status?since=${encodeURIComponent(since)}`,
          { cache: "no-store" },
        );
        const data = (await res.json()) as StatusResponse;
        if (data.run?.html_url) setRunUrl(data.run.html_url);

        // The changeset flipping to `applied` is the authoritative signal —
        // it lands in the same commit the workflow pushes.
        if (data.changesetStatus === "applied") {
          setPhase("applied");
          setMessage(
            data.targetVersion
              ? `Published as v${data.targetVersion}. The site rebuilds in about a minute.`
              : "Published. The site rebuilds in about a minute.",
          );
          return true;
        }
        if (data.run?.conclusion && data.run.conclusion !== "success") {
          setPhase("failed");
          setMessage(`The publish run ${data.run.conclusion}. Nothing was changed.`);
          return true;
        }
      } catch {
        // Transient — keep polling; the timeout below is the real backstop.
      }
      if (polls.current >= MAX_POLLS) {
        setPhase("failed");
        setMessage(
          "Still running after five minutes. It may yet finish — check the Actions run.",
        );
        return true;
      }
      return false;
    },
    [changesetId],
  );

  useEffect(() => {
    if (phase !== "running") return;
    const since = new Date(Date.now() - 60_000).toISOString();
    const t = setInterval(() => {
      void poll(since).then((done) => {
        if (done) clearInterval(t);
      });
    }, POLL_INTERVAL_MS);
    return () => clearInterval(t);
  }, [phase, poll]);

  /* ---------------- Publish ---------------- */

  const publish = useCallback(async () => {
    setPhase("publishing");
    setMessage("");
    setConfirming(false);
    try {
      window.localStorage.setItem(NAME_KEY, name);
    } catch {
      /* ignore */
    }
    try {
      const res = await fetch(`/api/enrich/${changesetId}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseSha: sha, reviewedBy: name, decisions: pendingDecisions }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setPhase("error");
        setMessage(data.error ?? "Could not publish.");
        return;
      }
      polls.current = 0;
      setPhase("running");
      setMessage("Applying — this takes a couple of minutes.");
    } catch {
      setPhase("error");
      setMessage("Network error. Nothing was published.");
    }
  }, [changesetId, name, pendingDecisions, sha]);

  /* ---------------- Render ---------------- */

  if (phase === "applied") {
    return (
      <div
        className="mt-8 rounded p-4"
        style={{ border: "1px solid var(--color-accent)" }}
      >
        <p className="label" style={{ color: "var(--color-accent)" }}>
          Published
        </p>
        <p className="mt-1 text-sm" style={{ color: "var(--color-text-muted)" }}>
          {message}
        </p>
      </div>
    );
  }

  const busy = phase === "publishing" || phase === "running";
  const nothingApproved = acceptedCount === 0;

  return (
    <div
      className="mt-8 rounded p-4"
      style={{ border: "1px solid var(--color-border, rgba(0,0,0,0.15))" }}
    >
      <h2 className="display" style={{ fontSize: "var(--text-lg)" }}>
        Publish
      </h2>

      <p className="prose-body mt-2 max-w-2xl text-sm" style={{ color: "var(--color-text-muted)" }}>
        {nothingApproved ? (
          <>Nothing is approved yet, so there is nothing to publish.</>
        ) : (
          <>
            Publishing writes the <strong>{acceptedCount}</strong> approved change
            {acceptedCount === 1 ? "" : "s"} into the {targetLabel} (currently v{baseVersion}),
            bumps its version, and regenerates the derived analytics. The other{" "}
            {totalCount - acceptedCount} will not be applied.
          </>
        )}
      </p>

      {undecidedCount > 0 && !nothingApproved ? (
        <p className="mt-2 text-sm" style={{ color: "var(--color-warn-strong)" }}>
          {undecidedCount} proposal{undecidedCount === 1 ? " is" : "s are"} still undecided.
          Publishing leaves {undecidedCount === 1 ? "it" : "them"} out — and{" "}
          {undecidedCount === 1 ? "it" : "they"} will be proposed again next month, since only
          an explicit decline is remembered.
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <label className="label" htmlFor="reviewer">
          Approved by
        </label>
        <input
          id="reviewer"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="your name"
          disabled={busy}
          className="ucnfi-input text-sm"
          style={{ minWidth: "14rem" }}
        />

        {!confirming ? (
          <button
            type="button"
            onClick={() => setConfirming(true)}
            disabled={busy || nothingApproved || !name.trim() || !sha}
            className="label rounded px-4 py-2 disabled:opacity-40"
            style={{
              background: "var(--color-accent)",
              color: "var(--color-surface)",
              cursor: busy || nothingApproved || !name.trim() ? "not-allowed" : "pointer",
            }}
          >
            {phase === "publishing"
              ? "Publishing…"
              : phase === "running"
                ? "Applying…"
                : `Publish ${acceptedCount}`}
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="label" style={{ color: "var(--color-warn-strong)" }}>
              This changes the live baseline.
            </span>
            <button
              type="button"
              onClick={() => void publish()}
              className="label rounded px-4 py-2"
              style={{
                background: "var(--color-accent)",
                color: "var(--color-surface)",
                cursor: "pointer",
              }}
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="label"
              style={{ color: "var(--color-text-subtle)", cursor: "pointer" }}
            >
              cancel
            </button>
          </div>
        )}
      </div>

      {!sha ? (
        <p className="mt-3 text-xs" style={{ color: "var(--color-text-subtle)" }}>
          Reading from the local filesystem — publishing needs GITHUB_TOKEN and GITHUB_REPO.
        </p>
      ) : null}

      {message ? (
        <p
          className="mt-3 text-sm"
          style={{
            color:
              phase === "error" || phase === "failed"
                ? "var(--color-danger)"
                : "var(--color-text-muted)",
          }}
        >
          {message}{" "}
          {runUrl ? (
            <a
              href={runUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-accent)" }}
            >
              View the run ↗
            </a>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
