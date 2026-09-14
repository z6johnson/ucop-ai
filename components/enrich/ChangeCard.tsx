"use client";

import type { Decision } from "@/lib/enrich/changeset-format";
import {
  KIND_LABEL,
  formatValue,
  kindExplanation,
  type ReviewChange,
} from "@/lib/enrich/review";

const CONFIDENCE_COLOR: Record<ReviewChange["confidence"], string> = {
  high: "var(--color-text-muted)",
  medium: "var(--color-warn-strong)",
  low: "var(--color-danger)",
};

/** Mutations read as heavier than additions, because they are. */
const KIND_COLOR: Record<ReviewChange["kind"], string> = {
  new_field: "var(--color-info)",
  unchanged_confirmed: "var(--color-text-subtle)",
  changed_value: "var(--color-warn-strong)",
  newly_contradicted: "var(--color-danger)",
  newly_absent: "var(--color-warn-strong)",
};

function DecisionButton({
  label,
  active,
  color,
  onClick,
  disabled,
}: {
  label: string;
  active: boolean;
  color: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className="label rounded px-3 py-1.5 transition-colors disabled:opacity-40"
      style={{
        background: active ? color : "transparent",
        color: active ? "var(--color-surface)" : color,
        border: `1px solid ${color}`,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

export function ChangeCard({
  change,
  decision,
  entityName,
  dimensionLabel,
  onDecide,
  readOnly,
  focused,
}: {
  change: ReviewChange;
  decision: Decision;
  entityName: string;
  dimensionLabel: string;
  onDecide: (d: Decision) => void;
  readOnly?: boolean;
  focused?: boolean;
}) {
  const decided = decision !== "review";

  return (
    <li
      className="hairline py-5"
      style={{
        borderLeft: focused ? "2px solid var(--color-accent)" : "2px solid transparent",
        paddingLeft: "0.75rem",
        // Decided cards recede so the eye lands on what still needs a call.
        opacity: decided && !focused ? 0.6 : 1,
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="display" style={{ fontSize: "var(--text-base)" }}>
          {entityName}
          <span style={{ color: "var(--color-text-subtle)" }}> · </span>
          <span style={{ color: "var(--color-text-muted)" }}>{dimensionLabel}</span>
        </h3>
        <div className="flex items-center gap-3">
          <span className="label" style={{ color: KIND_COLOR[change.kind] }}>
            {KIND_LABEL[change.kind]}
          </span>
          <span className="label" style={{ color: CONFIDENCE_COLOR[change.confidence] }}>
            {change.confidence} confidence
          </span>
        </div>
      </div>

      <p className="mt-1 font-mono text-xs" style={{ color: "var(--color-text-subtle)" }}>
        {change.field}
      </p>

      {/* The comparison the markdown diff could never show. */}
      <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
        <span
          className="rounded px-2 py-1"
          style={{
            background: "var(--color-surface-muted, rgba(0,0,0,0.04))",
            color: "var(--color-text-muted)",
            textDecoration: change.currentValue !== undefined ? "line-through" : "none",
          }}
        >
          {change.currentValue === undefined ? "not recorded" : formatValue(change.currentValue)}
        </span>
        <span aria-hidden style={{ color: "var(--color-text-subtle)" }}>→</span>
        <span
          className="rounded px-2 py-1"
          style={{
            background: "var(--color-surface-muted, rgba(0,0,0,0.04))",
            color: "var(--color-text)",
            fontWeight: 600,
          }}
        >
          {formatValue(change.proposedValue)}
        </span>
      </div>

      <p className="mt-2 text-xs" style={{ color: "var(--color-text-subtle)" }}>
        {kindExplanation(change)}
      </p>

      {change.notes ? (
        <p className="prose-body mt-2 max-w-2xl text-sm" style={{ color: "var(--color-text-muted)" }}>
          {change.notes}
        </p>
      ) : null}

      <p className="mt-2 text-xs" style={{ color: "var(--color-text-subtle)" }}>
        Source: {change.sourceId ?? "—"}
        {change.sourceUrl ? (
          <>
            {" · "}
            <a
              href={change.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--color-accent)" }}
            >
              open ↗
            </a>
          </>
        ) : null}
      </p>

      {change.flags.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {change.flags.map((f) => (
            <li key={f} className="text-xs" style={{ color: "var(--color-danger)" }}>
              ⚠ {f}
            </li>
          ))}
        </ul>
      ) : null}

      {!readOnly ? (
        <div className="mt-3 flex items-center gap-2">
          <DecisionButton
            label="Approve"
            active={decision === "accept"}
            color="var(--color-accent)"
            onClick={() => onDecide("accept")}
          />
          <DecisionButton
            label="Decline"
            active={decision === "reject"}
            color="var(--color-danger)"
            onClick={() => onDecide("reject")}
          />
          {decided ? (
            <button
              type="button"
              onClick={() => onDecide("review")}
              className="label ml-1"
              style={{ color: "var(--color-text-subtle)", cursor: "pointer" }}
            >
              clear
            </button>
          ) : null}
        </div>
      ) : (
        <p className="label mt-3" style={{ color: "var(--color-text-subtle)" }}>
          {decision === "accept" ? "Approved" : decision === "reject" ? "Declined" : "No decision"}
        </p>
      )}
    </li>
  );
}
