# UCOP

**UCOP AI Steering Committee — research, synthesis, and analytics platform.**

A Next.js web app over the AI governance baseline dataset (20 entities, 262 data points, 10 dimensions, v0.7.0) and the UCOP AI Steering Committee directory (23 members), with a grounded Claude copilot that cites every claim back to a specific entity or member. Organized around the three pillars and eight Opportunity Areas of the UCOP North Star.

## Surfaces

| Route | Purpose |
|---|---|
| `/` | Compare matrix — pick a dimension and a set of entities, read the same question answered for each. |
| `/expertise` | Committee directory with filters for expertise, opportunity area, sector, and AI relationship. List and matrix views. |
| `/chat` | Claude-powered research copilot grounded in the baseline + committee directory. Inline `[entity_id]` and `[member-id]` citations open a side drawer. |
| `/baseline`, `/baseline/[id]` | Per-entity detail pages over the baseline JSON. |
| `/about` | Strategy, the ten dimensions, method, and known gaps. |
| `/admin/enrich` | Review queue for the monthly enrichment run — approve or decline each proposed change and publish. Admin-gated. |

Memo drafting and comparison are scaffolded but hidden from the global nav while content is finalized. The underlying routes (`/memos`, `/memos/new`, `/api/memos`) and admin gate are unchanged.

## Status

| | Step | What it adds |
|---|---|---|
| ✓ | **Step 1 — Baseline Explorer** | Compare matrix on `/`, entity detail pages, NFI design tokens. No runtime dependencies. |
| ✓ | **Step 2 — Grounded Chat** | Streaming Claude chat with the baseline + committee directory in a prompt-cached system prompt, inline citation chips wired to side drawers. |
| ✓ | **Expertise directory** | `/expertise` with searchable, filterable committee directory and a member × OA matrix view. |
| ☐ | **Step 3 — Persistence + Shares** | Postgres + Drizzle, saved chats, admin cookie gate, read-only share links. |
| ☐ | **Step 4 — Memos + Comparison** | Memo drafting (scaffolded; nav entry hidden for now), seeded published memos. |
| ☐ | **Step 5 — Polish** | Copy pass, custom domain, analytics. |

Full plan: [`docs/v1-plan.md`](docs/v1-plan.md).

## Quickstart

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. No environment variables are required for Step 1 — the baseline JSON is read at build time and every page is prerendered.

Type check and production build:

```bash
npm run typecheck
npm run build
```

## Repository layout

```
app/          Next.js App Router pages and API routes
components/   React components aligned to docs/seed-style-guide.md
content/      Single source of truth for pillars, OAs, research topics
lib/          Typed loader and query layer over the baseline JSON
data/         Baseline dataset (v0.7.0), committee directory, and enrichment tooling
docs/         Plan, principles, style guide
```

Key files:

- [`data/uc_ai_baseline.json`](data/uc_ai_baseline.json) — entity dataset (source of truth, v0.7.0)
- [`data/ucnfi-committee/`](data/ucnfi-committee/) — committee directory records, schema, and enrichment strategy
- [`data/ENRICHMENT_LOG.md`](data/ENRICHMENT_LOG.md) — dataset version history and gaps
- [`data/enrich/changesets/`](data/enrich/changesets/) — monthly proposals. `{id}.md` awaits review at `/admin/enrich`; `{id}-auto.md` was published automatically under policy; `.rejected.json` and `.suppressed.json` record what never made it in and why
- [`lib/enrich/diff.ts`](lib/enrich/diff.ts) — the policy deciding what may publish without a human
- [`lib/enrich/apply.ts`](lib/enrich/apply.ts) — the only module that writes canonical data, and the gate it enforces
- [`content/northstar.ts`](content/northstar.ts) — pillars, Opportunity Areas, research topics
- [`lib/baseline.ts`](lib/baseline.ts) — typed accessors (`listEntities`, `getEntity`, `queryBaseline`, `baselineStats`)
- [`lib/committee.ts`](lib/committee.ts) — committee directory loader and facets
- [`docs/v1-plan.md`](docs/v1-plan.md) — approved v1 implementation plan
- [`docs/responsible-ai-seed-principles.md`](docs/responsible-ai-seed-principles.md)
- [`docs/seed-style-guide.md`](docs/seed-style-guide.md)

## Design system

Design tokens in [`app/globals.css`](app/globals.css) derive from the seed style guide and the NFI color palette — warm-neutral base, single brand accent (`#005581`), and a disciplined set of semantic tokens. The full mapping lives under **NFI color tokens** in [`docs/v1-plan.md`](docs/v1-plan.md).

Fonts fall back to system sans for UI and system serif for memo body. No external font loading is wired up yet — add Inter / Source Serif 4 via `next/font` in Step 5 if desired.

---

## Deployment — Vercel

The app is a stock Next.js 15 project. Vercel's framework preset auto-detects everything; install command, build command, and output directory can stay on their defaults.

General project settings (applied once at import):

- **Framework preset:** Next.js (auto)
- **Root directory:** repo root (`./`)
- **Node.js version:** 20.x
- **Function region:** `sfo1` or `pdx1` for low-latency California access (Project Settings → Functions → Region)

### Step 1 — Baseline Explorer

**No configuration needed.**

1. Import the GitHub repo into Vercel.
2. Accept the auto-detected Next.js preset.
3. Deploy.

Every page is prerendered at build time (28 static pages, including all 20 entity detail pages), so the deployment is effectively a static site with zero runtime dependencies. No environment variables, no database, no secrets.

### Step 2 — Grounded Chat

Adds the Anthropic Claude SDK (`@anthropic-ai/sdk`) pointed at the UCSD TritonAI LiteLLM proxy — the sole LLM provider — and a streaming `/api/chat` route with prompt caching of the full baseline. The SDK is just the wire format here: `/api/chat` calls an open-weight model on the proxy by default (`CHAT_MODEL`), not Claude.

**Environment variables** (Project Settings → Environment Variables — add to Production, Preview, and Development):

| Name | Value | Sensitive |
|---|---|---|
| `LITELLM_API_KEY` | TritonAI LiteLLM bearer token | ✓ |
| `LITELLM_BASE_URL` | Optional; defaults to `https://tritonai-api.ucsd.edu` | — |

**Function duration.** The `/api/chat` route will export `maxDuration = 60` so Vercel allows long-running streams. On Vercel's Hobby plan, Serverless Function duration is capped — upgrade to Pro if streaming responses are getting truncated.

**Runtime.** Node runtime (not Edge) so the Claude SDK's prompt caching and streaming helpers work without shimming.

No database yet — chat history lives in the browser (URL/localStorage) until Step 3.

### Step 3 — Persistence + Share Links

Adds Postgres + Drizzle ORM, saved chats, admin cookie gate, and `/share/[slug]` read-only resolver.

**1. Provision Postgres.** In Vercel: **Storage → Create Database → Neon Postgres**. Link it to the project. Neon auto-injects `DATABASE_URL` (and `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, etc.) into Production and Preview environments.

**2. Add environment variables:**

| Name | Value | Sensitive | Notes |
|---|---|---|---|
| `ADMIN_PASSWORD` | Strong random string | ✓ | Gates Zach's editing routes via an HTTP-only cookie |
| `NFI_BASE_URL` | `https://<project>.vercel.app` or your custom domain | — | Used to build absolute share URLs |

**3. Run migrations once** against the Neon database from your local machine:

```bash
# Pull env vars from Vercel into a local .env
npx vercel env pull .env.local

# Push the Drizzle schema to Neon
npm run db:push
```

The `db:push` script will be added in Step 3 and wraps `drizzle-kit push`. Preview deployments automatically share the same database in this setup — if you want isolated preview DBs, create a second Neon branch and scope `DATABASE_URL` to the Preview environment.

### Step 4 — Memos + Comparison

Memos are markdown files under `content/memos/` and are pre-rendered at build time. New memos can be drafted from `/memos/new` and are committed to the repo via the GitHub Contents API — Vercel's Git integration rebuilds the site and publishes the memo (~60s).

**Environment variables:**

| Name | Value | Sensitive | Notes |
|---|---|---|---|
| `ADMIN_PASSWORD` | Strong random string | ✓ | Gates `/memos/new` and `/api/memos` via an HTTP-only cookie (HMAC-signed; rotating invalidates sessions) |
| `GITHUB_TOKEN` | Fine-grained PAT | ✓ | Scoped to `z6johnson/ucnfi` only, `Contents: Read and write`. Rotate on expiry. |
| `GITHUB_REPO` | `z6johnson/ucnfi` | — | Target for memo commits |
| `GITHUB_BRANCH` | `main` | — | Optional, defaults to `main` |

Add these to both Production and Preview environments — a memo submitted on a preview deploy commits to `main` and triggers a production rebuild.

**Branch protection.** Don't enable "Require a pull request before merging" on `main`; the GitHub Contents API writes direct commits. If branch protection becomes a requirement, switch the memo route to a branch-and-PR flow.

The comparison matrix is a pure read over the baseline JSON — no additional config.

### Step 5 — Polish

No required config changes. Optional:

- **Custom domain** — Project Settings → Domains → add your hostname and follow Vercel's DNS instructions. Update `NFI_BASE_URL` to match.
- **Vercel Analytics** — toggle on from the project dashboard for page-view counts and Web Vitals.
- **Seed memos** — once `/api/memo/generate` is live, seed a handful of published committee memos (campus maturity gradient, governance gap summary, health AI snapshot) and copy their share URLs into the committee comms.

---

## Environment variable summary

| Variable | Step introduced | Purpose |
|---|---|---|
| `LITELLM_API_KEY` | Step 2 | TritonAI LiteLLM bearer token for chat + memo generation |
| `LITELLM_BASE_URL` | Step 2 | Optional LiteLLM proxy URL (defaults to `https://tritonai-api.ucsd.edu`) |
| `CHAT_MODEL` | Step 2 | Optional. Model ID used by `/api/chat`. Defaults to `api-glm-5.3` (open-weight). |
| `CLAUDE_MODEL` | Step 2 | Optional. Model ID used where Claude is specifically required (the Brief; web_search-tool calls). Defaults to `claude-sonnet-5`. |
| `DATABASE_URL` | Step 3 | Neon Postgres connection string |
| `ADMIN_PASSWORD` | Step 3 | Admin cookie gate for editing routes |
| `NFI_BASE_URL` | Step 3 | Absolute URL used when generating share links |
| `GITHUB_TOKEN` | Step 4 | Fine-grained PAT — `Contents: Read and write` to commit memos and enrichment decisions, `Actions: Read and write` to start the enrichment publish run |
| `GITHUB_REPO` | Step 4 | `owner/repo` target for memo commits |
| `GITHUB_BRANCH` | Step 4 | Optional, defaults to `main` |

See [`.env.example`](.env.example) for the local template.
