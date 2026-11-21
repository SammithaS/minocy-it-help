# Minocy IT Help

An edge-native, multi-agent IT self-service portal on Cloudflare's free plan. An employee describes a problem once; a **supervisor agent** routes it to the right **specialist** — fix it with the IT guides, request access to an app, reset a password, check a ticket, or raise one — and **durable workflows** coordinate the back office: triage, SLA timers, email, manager approvals and turning resolved tickets into knowledge-base improvements.

> *A supervisor agent routes, specialists act, durable workflows coordinate — every agent is a Durable Object on Cloudflare's free plan, and nothing costs money.*

## How it fits together

```mermaid
flowchart LR
  E([Employee]) -- WebSocket --> S["SupportAgent<br/>supervisor · 1 DO per chat<br/>rules first, model only if unclear"]
  S -- hand-off --> K["KnowledgeAgent<br/>hybrid KB search → guide"]
  S -- hand-off --> A["AccessAgent<br/>catalog match · grants · approver"]
  S -- hand-off --> T["TicketAgent<br/>title · summary · team · priority"]
  S -. deterministic tools .-> P["Password reset<br/>code → approve → link"]
  S -. 24 h schedule() .-> F["Follow-up<br/>“still working?”"]
  A -- approved card --> AW[["AccessRequestWorkflow<br/>manager link → provision → notify"]]
  T -- approved card --> TW[["TicketWorkflow<br/>triage · email · SLA · resolve · confirm"]]
  TW --> TR["TriageAgent<br/>duplicates · cause · assignee"]
  TW -- on resolve --> G["KnowledgeGapAgent<br/>KB proposal"]
  G --> Q[(Proposals queue)] -- admin approves --> RW[["KbReindexWorkflow<br/>embed → Vectorize → D1/FTS"]]
  IT([IT staff]) -- console --> C[Console · live queue · analytics]
  IT -- Claude / IDE --> M["IT Ops MCP server<br/>/mcp · personal tokens"]
```

| Agent | Kind | Runs when | Model calls |
|---|---|---|---|
| **SupportAgent** (supervisor) | `AIChatAgent`, one Durable Object per conversation | every chat turn | ≤ 1 per turn; 0 for rule-routed hand-offs and fixed confirmations |
| **KnowledgeAgent** | facet sub-agent | new troubleshooting request | 0 when one guide clearly wins, else 1 |
| **AccessAgent** | facet sub-agent | access request | 0 when the app is named, else 1 |
| **TicketAgent** | facet sub-agent | user agrees to a ticket | 1 |
| **TriageAgent** | Agent DO, run by `TicketWorkflow` | ticket created | 1 (rules-only fallback) |
| **KnowledgeGapAgent** | Agent DO, run by `TicketWorkflow` | ticket resolved | 0–1 (rules skip, daily budget) |
| **IT Ops MCP server** | stateless MCP handler (`agents/mcp/server`) | IT staff ask from Claude | 0 |

Routing is **rules first** (`src/agents/router.ts`): 90 % of the routing eval is decided without a model call. Gemini Flash-Lite → Flash run through AI Gateway, with Workers AI as the fallback; every fallback is counted per agent in analytics.

## What's in it

- **Portal** — hero ask box and quick-action tiles that hand off to the supervisor in a **docked chat** (full-screen sheet on phones); full-page chat with history; step-by-step guide cards; editable ticket draft card; access-request card; password-reset code and confirmation cards; 👍/👎 feedback; a 24 h follow-up; *My tickets & requests*.
- **Back office** — `TicketWorkflow` (triage → team/employee email → SLA reminder at 75 % → escalation at 100 % → resolve → "Did this fix it?" → close/reopen), `AccessRequestWorkflow` (signed Approve/Reject links → mock provisioning), `KbReindexWorkflow`; inbound email (`help@` → ticket, `ticket+INC-…@` → comment); daily digest.
- **IT console** — live queue (WebSocket) with filters, SLA chips, ticket view with transcript and triage note, assign / start / waiting / resolve, routing & SLA settings, KB editor, knowledge-gap proposals with a diff, analytics, email Outbox, **Connect Claude**.
- **Security** — email-OTP sign-in (no passwords), server-side ownership checks on every chat and ticket, approval cards for anything with side effects, signed expiring email links (GET shows, POST acts), secrets never stored or shown to the model, hashed MCP tokens.

## Quick start

Requirements: Node 22+ and pnpm 9, a (free) Cloudflare account, and a free Gemini API key from aistudio.google.com.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # set BETTER_AUTH_SECRET and GOOGLE_GENERATIVE_AI_API_KEY
pnpm db:reset                    # apply migrations + seed local D1
pnpm exec wrangler login         # once; Vectorize + Workers AI run on your (free) account
pnpm exec wrangler vectorize create it-kb --preset=@cf/baai/bge-base-en-v1.5   # once, plus metadata indexes below
pnpm kb:ingest                   # embed kb/*.md into Vectorize + local D1
pnpm dev                         # http://localhost:5173 (API + app on one port)
```

One-time Vectorize metadata indexes:

```bash
for p in "category string" "section string" "os_windows boolean" "os_macos boolean" "os_linux boolean"; do
  set -- $p; pnpm exec wrangler vectorize create-metadata-index it-kb --property-name=$1 --type=$2
done
```

Sign in with a seeded account — no real email needed locally. The 6-digit code is printed in the `pnpm dev` terminal (`[email:dev] … Your sign-in code is …`) unless `RESEND_API_KEY` is set.

| Role | Email |
|---|---|
| Employee | `ananya.sharma@minocy.example` (+7 more; `rohan.das@…` has a **locked** directory account for the reset demo, `meera.krishnan@…` already has Figma) |
| Manager (approves access) | `deepa.menon@…` (Finance, HR, Ops), `nikhil.bose@…` (Sales, Marketing), `lakshmi.pillai@…` (Design, Engineering) |
| IT Agent | `arjun.mehta@minocy.example` (Network), `priya.nair@…` (Hardware), `rahul.verma@…` (Software), `sneha.iyer@…` (Identity & Access), `vikram.singh@…` (Collaboration) |
| IT Admin | `admin@minocy.example`, plus your own address if you seed with `SEED_OWNER_EMAIL=you@example.com SEED_OWNER_NAME="Your Name" pnpm db:seed` |

## Use it from Claude (MCP)

IT staff open **Console → Connect Claude**, create a personal access token (shown once, stored as a SHA-256 hash), then:

```bash
claude mcp add --transport http minocy-itops http://localhost:5173/mcp --header "Authorization: Bearer <token>"
```

Tools: `listMyTeamTickets` (status / priority / overdue / assigned-to-me filters), `getTicket` (steps tried, triage note, comments), `addInternalNote`. Everything is scoped to the token owner's teams (admins: all); revoking the token cuts access immediately.

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Vite + Cloudflare plugin: Worker, API and React app on one port |
| `pnpm build` | Production build (`dist/`) |
| `pnpm test` | Vitest inside the Workers runtime (Miniflare) — 130 tests, no real keys or mail |
| `pnpm e2e` | Playwright end-to-end tests (starts its own `pnpm dev`; stop yours first). Uses the Edge that ships with Windows; `E2E_CHANNEL=chrome` elsewhere |
| `pnpm eval [suite…]` | promptfoo evals → [`evals/RESULTS.md`](evals/RESULTS.md): `retrieval`, `routing`, `escalation`, `ticket-quality` (LLM judge), `triage` |
| `pnpm typecheck` / `pnpm lint` | TypeScript project build / ESLint |
| `pnpm db:generate` | Generate a SQL migration from `src/db/schema.ts` |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | Apply migrations / seed / both, on local D1 |
| `pnpm kb:check` | Validate kb/*.md (frontmatter, sections, placeholders) |
| `pnpm kb:ingest [--force]` | Chunk + embed the KB into Vectorize and local D1 (skips unchanged and console-edited articles) |
| `pnpm kb:search "query"` | Debug hybrid search from the terminal |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |

## Email

`EMAIL_TRANSPORT=log` (default) renders every email and stores it in the admin **Outbox** (`/console/outbox`) — no domain or accounts needed. For real sending, set up a domain on Cloudflare (Email Routing + verified team mailboxes) and Resend, then set `EMAIL_TRANSPORT=live` (see README).

Password-reset codes and set-password links are sent like any other email, but the Outbox keeps only their subject and recipient (admins mustn't read them); in `log` mode their text is printed in the `pnpm dev` terminal, like sign-in codes. Manager approval emails are normal Outbox entries — open one and click **Approve** to finish an access request locally.

Simulate inbound email locally:

```bash
curl -X POST --data-binary @reply.eml "http://localhost:5173/cdn-cgi/handler/email?from=ananya.sharma@minocy.example&to=ticket%2BINC-1004@minocy.example"
```

## Layout

```
src/                 Worker: index.ts (fetch, email, scheduled)
  agents/            support-agent (supervisor), router, state, prompts, tools, specialists/, triage-agent, kb-gap-agent
  workflows/         ticket-workflow, access-workflow, kb-reindex-workflow
  api/               Hono routes (auth, tickets, console, console-admin, chats, access, kb, public)
  mcp/               IT Ops MCP server (tokens + tools)
  lib/               tickets, access, password-reset, kb-index, llm (Gemini → Workers AI), tokens, sla
  email/             React Email templates, send (Outbox / live), inbound, digest
  rag/               kb-sections (parse + chunk), embed, rrf, search (Vectorize + FTS5 hybrid)
  durable/           TicketBoard (live console WebSocket)
web/src/             React 19 + TanStack Router/Query + Tailwind v4 ("Clear Sky" tokens in styles.css)
migrations/          D1 migrations (drizzle-kit)
kb/                  20 knowledge base articles (markdown + frontmatter)
scripts/             seed, check-kb, ingest-kb, search-kb, eval
evals/               promptfoo suites + providers/
tests/               Vitest in the Workers pool        e2e/   Playwright
```

## Stack

Cloudflare Workers · Durable Objects (SQLite) · Workflows · D1 + Drizzle · Vectorize + Workers AI (bge-base-en-v1.5, Workers AI fallback LLM) · AI Gateway · Email Service + Email Routing · Agents SDK (`AIChatAgent`, facets, `schedule()`, MCP) + AI SDK 7 · Gemini · Hono + Zod · Better Auth (email OTP) · React 19 + Vite · TanStack Router & Query · Tailwind CSS v4 · React Email · Vitest (Workers pool) · Playwright · promptfoo.
