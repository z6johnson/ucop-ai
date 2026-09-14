import Link from "next/link";
import { Stat } from "@/components/Stat";
import {
  baselineStats,
  DIMENSION_IDS,
  DIMENSION_LABEL,
  dimensionDescriptions,
  listEntities,
  metadata,
} from "@/lib/baseline";
import { AppliedList, PendingList } from "@/components/enrich/ChangesetList";
import { allChangesetSummaries } from "@/lib/enrich/source";

export const dynamic = "force-dynamic";

function ageInDays(isoDate: string): number {
  const then = Date.parse(isoDate);
  if (Number.isNaN(then)) return 0;
  return Math.floor((Date.now() - then) / 86_400_000);
}

export default async function AboutPage() {
  const stats = baselineStats();
  const entities = listEntities();

  // Read through the GitHub API rather than readdirSync: next.config.ts does
  // not trace the changeset files into this route's serverless bundle, so the
  // filesystem read found nothing in production.
  const summaries = await allChangesetSummaries();
  const pending = summaries
    .filter((s) => s.status === "draft" && s.approval_mode === "human")
    .sort((a, b) => b.run_date.localeCompare(a.run_date));
  const applied = summaries
    .filter((s) => s.status === "applied")
    .sort((a, b) => b.applied_at.localeCompare(a.applied_at));
  const age = ageInDays(metadata.created);
  const stale = age > 45;

  const dimStats = DIMENSION_IDS.map((d, i) => {
    let entityCount = 0;
    let fieldCount = 0;
    for (const e of entities) {
      const bucket = e[d];
      if (bucket && Object.keys(bucket).length > 0) {
        entityCount += 1;
        fieldCount += Object.keys(bucket).length;
      }
    }
    return {
      index: i + 1,
      id: d,
      label: DIMENSION_LABEL[d],
      description: dimensionDescriptions[d],
      entityCount,
      fieldCount,
    };
  });

  return (
    <div className="pt-12">
      <header>
        <span className="label">UCOP · About this resource</span>
        <h1 className="hero mt-2 max-w-3xl">
          How this baseline was built, and what to do with it
        </h1>
      </header>

      {/* ---------- Strategy ---------- */}
      <section className="mt-16">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">Strategy</h2>
          <span className="label">Why this exists</span>
        </div>
        <div className="mt-6 grid gap-8 md:grid-cols-3">
          <article
            className="rail-accent"
            style={{ borderLeftColor: "var(--color-accent)" }}
          >
            <span className="label">Shared picture</span>
            <p
              className="mt-2 text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              Committee work starts with an honest map of the current
              state. Before the Steering Committee asks what UC should do
              next, it needs a single baseline of what UC has already
              done — one schema, one set of sources, every entity treated
              the same way.
            </p>
          </article>
          <article
            className="rail-accent"
            style={{ borderLeftColor: "var(--color-accent)" }}
          >
            <span className="label">Traceable claims</span>
            <p
              className="mt-2 text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              Every fact on this site traces back to a public document.
              Each field carries a <code>source_id</code>, a URL where
              available, and committee-relevant notes — so any finding
              survives an audit from a board member, a reporter, or a
              campus the data mentions.
            </p>
          </article>
          <article
            className="rail-accent"
            style={{ borderLeftColor: "var(--color-accent)" }}
          >
            <span className="label">Grounded synthesis</span>
            <p
              className="mt-2 text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              The research copilot is bound to the same baseline and must
              cite the specific entity, dimension, and field it pulled
              from. Synthesis is not a hallucination — it is a function
              over this dataset.
            </p>
          </article>
        </div>
      </section>

      {/* ---------- Coverage ---------- */}
      <section className="mt-16">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">Coverage</h2>
          <span className="label">Baseline v{stats.version}</span>
        </div>
        <div className="mt-6 grid grid-cols-2 gap-8 md:grid-cols-4">
          <Stat label="Entities" value={stats.entityCount} />
          <Stat
            label="Data points"
            value={stats.dataPointCount}
            hint={`Across ${DIMENSION_IDS.length} dimensions`}
          />
          <Stat
            label="Campuses"
            value={stats.byType.campus}
            hint={`${stats.byType.health_system} health · ${stats.byType.national_lab} labs`}
          />
          <Stat label="Systemwide" value={stats.byType.systemwide} />
        </div>
        <p
          className="prose-body mt-6 max-w-2xl"
          style={{ color: "var(--color-text-muted)" }}
        >
          The baseline currently covers the UC Office of the President, all
          ten campuses, the five UC Health systems plus the cross-UC health
          collaborative, and the three UC-affiliated national labs (LBNL,
          LLNL, LANL).
        </p>
      </section>

      {/* ---------- Dimensions ---------- */}
      <section className="mt-16">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">The ten dimensions</h2>
          <span className="label">Schema</span>
        </div>
        <p
          className="prose-body mt-4 max-w-2xl"
          style={{ color: "var(--color-text-muted)" }}
        >
          Every entity is profiled along the same ten dimensions. Each
          dimension contains a set of fields; each field is a boolean,
          short string, or enum with a <code>source_id</code>, source URL,
          and committee-relevant notes. A field is only recorded when a
          public document substantiates it — absence of a field means
          absence of evidence in the public record, not absence of the
          activity itself.
        </p>
        <ul className="mt-8 flex flex-col gap-6">
          {dimStats.map((d) => (
            <li
              key={d.id}
              className="rail-accent"
              style={{ borderLeftColor: "var(--color-border-hair)" }}
            >
              <div className="flex items-baseline justify-between gap-4">
                <div>
                  <span className="label">Dimension {d.index}</span>
                  <h3
                    className="mt-1 text-base font-semibold"
                    style={{ color: "var(--color-ink)" }}
                  >
                    {d.label}
                  </h3>
                </div>
                <span
                  className="label shrink-0"
                  title={`${d.fieldCount} total fields across ${d.entityCount} entities`}
                >
                  {d.fieldCount} fields · {d.entityCount} entities
                </span>
              </div>
              <p
                className="mt-2 text-sm"
                style={{ color: "var(--color-text-muted)" }}
              >
                {d.description}
              </p>
            </li>
          ))}
        </ul>
      </section>

      {/* ---------- Method ---------- */}
      <section className="mt-16">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">Method</h2>
          <span className="label">How the data was captured</span>
        </div>
        <ol className="mt-6 flex flex-col gap-6">
          <MethodStep
            n="01"
            title="Document inventory"
            body="Built a structured inventory of every public-facing UC AI governance artifact we could find — campus portals, policy PDFs, chancellor statements, health-system councils, national lab positions. Nothing was included without a publicly addressable source."
          />
          <MethodStep
            n="02"
            title="Archive + extract"
            body="Archived web pages via Chrome and downloaded the PDFs. Each was read and parsed against the ten-dimension schema; every extracted fact received a source id, URL, and a short note explaining why it mattered for the committee."
          />
          <MethodStep
            n="03"
            title="Equal treatment"
            body="Every campus, health system, and lab was processed through the same pipeline. UC Merced and UC Riverside received the same schema rows as UC Berkeley and UCLA, so the absence of a field is comparable across entities rather than an artifact of uneven attention."
          />
          <MethodStep
            n="04"
            title="Iterative enrichment"
            body="The baseline is versioned. v0.1 was a skeleton, v0.5 completed a full PDF pass, and v0.6 added a web-archive enrichment pass covering ~80 additional pages. v0.7 ran a targeted gap-fill across the thin dimensions, and from v0.8 a monthly automated enrichment run proposes changes for human review. Each bump is logged in data/ENRICHMENT_LOG.md alongside the sources it relied on and the pages that could not be reached."
          />
          <MethodStep
            n="05"
            title="Grounded analysis"
            body="The AI research copilot is given the full baseline as cached system context and a structured query tool. That means every claim it makes can be traced back to a specific (entity, dimension, field) triple — the model is not free to invent governance structures or quote policy language that is not in the dataset."
          />
        </ol>
      </section>

      {/* ---------- Known gaps ---------- */}
      <section className="mt-16">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">Known gaps</h2>
          <span className="label">Honesty</span>
        </div>
        <p
          className="prose-body mt-4 max-w-2xl"
          style={{ color: "var(--color-text-muted)" }}
        >
          Absence of a field means the public record did not yield evidence
          as of the last enrichment pass. The larger holes worth naming
          explicitly:
        </p>
        <ul
          className="mt-4 flex max-w-2xl flex-col gap-2 text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          <li>
            <strong style={{ color: "var(--color-ink)" }}>UC Irvine</strong>
            {" "}— no single campus-level AI council; governance is
            distributed across OVPTL (which now convenes an AI Advisory
            Committee), OIT, and the Office of Research.
          </li>
          <li>
            <strong style={{ color: "var(--color-ink)" }}>UC Merced</strong>
            {" "}— no standalone provost or chancellor AI memo at the time
            of enrichment.
          </li>
          <li>
            <strong style={{ color: "var(--color-ink)" }}>
              National labs
            </strong>
            {" "}— LBNL, LLNL, and LANL are governed by DOE/NNSA directives
            rather than UC frameworks, so they have no standalone
            institutional UC AI policy.
          </li>
          <li>
            <strong style={{ color: "var(--color-ink)" }}>UCSF</strong>
            {" "}— several pages sit behind MyAccess authentication and
            could not be archived.
          </li>
          <li>
            <strong style={{ color: "var(--color-ink)" }}>
              UCI Health
            </strong>
            {" "}— active internal governance processes without a public,
            standalone policy document.
          </li>
        </ul>
      </section>

      {/* ---------- Metadata ---------- */}
      <section className="mt-16">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">Dataset metadata</h2>
          <span className="label">Provenance</span>
        </div>
        <dl className="mt-6 grid max-w-3xl gap-6 md:grid-cols-2">
          <div>
            <dt className="label">Title</dt>
            <dd
              className="mt-1 text-sm"
              style={{ color: "var(--color-ink)" }}
            >
              {metadata.title}
            </dd>
          </div>
          <div>
            <dt className="label">Version</dt>
            <dd
              className="mt-1 text-sm"
              style={{ color: "var(--color-ink)" }}
            >
              v{metadata.version}
            </dd>
          </div>
          <div>
            <dt className="label">Created</dt>
            <dd
              className="mt-1 text-sm"
              style={{ color: "var(--color-ink)" }}
            >
              {metadata.created}
            </dd>
          </div>
          <div>
            <dt className="label">Schema</dt>
            <dd
              className="mt-1 text-sm"
              style={{ color: "var(--color-ink)" }}
            >
              v{metadata.schema_version}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="label">Purpose</dt>
            <dd
              className="mt-1 text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              {metadata.purpose}
            </dd>
          </div>
          <div className="md:col-span-2">
            <dt className="label">Source</dt>
            <dd
              className="mt-1 text-sm"
              style={{ color: "var(--color-text-muted)" }}
            >
              {metadata.source}
            </dd>
          </div>
        </dl>
      </section>

      {/* ---------- Data status ---------- */}
      <section id="data-status" className="mt-16 scroll-mt-24">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">Data status</h2>
          <span className="label">When the data was last updated</span>
        </div>

        <div
          className="mt-6 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm"
          style={{ color: "var(--color-text-subtle)" }}
        >
          <span>
            Live baseline <strong>v{stats.version}</strong> · {stats.entityCount}{" "}
            entities · {stats.dataPointCount} data points
          </span>
          <span>
            as of {metadata.created}
            {stale ? (
              <span style={{ color: "var(--color-warn-strong)" }}>
                {" "}
                · {age} days old
              </span>
            ) : null}
          </span>
        </div>

        <p
          className="prose-body mt-4 max-w-2xl text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          The shared picture is refreshed by a monthly enrichment run, and what
          it finds is handled in one of two ways. Changes that assert something
          new about an entity — a value that differs from the current one, a
          claim below high confidence, anything about a committee member — are{" "}
          <em>proposals</em>, and reach this baseline only once a human has
          reviewed and published them. Purely additive high-confidence fields,
          and re-confirmations of values already recorded here, are published
          automatically; those are marked below as such, and are listed with the
          policy that allowed them rather than a reviewer&rsquo;s name.
        </p>

        <div className="mt-10">
          <h3 className="display" style={{ fontSize: "var(--text-lg)" }}>
            Pending review
            {pending.length > 0 ? (
              <span
                className="label ml-3"
                style={{ color: "var(--color-warn-strong)" }}
              >
                {pending.length} awaiting
              </span>
            ) : null}
          </h3>
          <PendingList items={pending} />
        </div>

        <div className="mt-12">
          <h3 className="display" style={{ fontSize: "var(--text-lg)" }}>
            Applied refreshes
          </h3>
          <AppliedList items={applied} />
        </div>
      </section>

      {/* ---------- Jump-off ---------- */}
      <section className="mt-16">
        <div className="hairline flex items-baseline justify-between pb-2">
          <h2 className="display">Start here</h2>
        </div>
        <ul className="mt-6 flex flex-wrap gap-6">
          <li>
            <Link href="/" className="label">
              → See the system at a glance
            </Link>
          </li>
          <li>
            <Link href="/baseline" className="label">
              → Browse the baseline by entity
            </Link>
          </li>
          <li>
            <Link href="/chat" className="label">
              → Ask the research copilot
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}

function MethodStep({
  n,
  title,
  body,
}: {
  n: string;
  title: string;
  body: string;
}) {
  return (
    <li className="flex gap-5">
      <span
        className="label shrink-0 pt-1"
        style={{ minWidth: "3rem" }}
      >
        {n}
      </span>
      <div>
        <p
          className="text-base font-semibold"
          style={{ color: "var(--color-ink)" }}
        >
          {title}
        </p>
        <p
          className="mt-1 max-w-2xl text-sm"
          style={{ color: "var(--color-text-muted)" }}
        >
          {body}
        </p>
      </div>
    </li>
  );
}
