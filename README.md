# Minocy IT Help

An edge-native AI self-service IT portal on Cloudflare Workers. Employees describe a problem to an AI assistant that walks them through the fix from the company knowledge base; if that doesn't work, it raises a ticket with everything already tried and emails the right IT team.

> *The AI helps first, a human takes over cleanly — and everything runs on one edge platform with zero servers.*

## Quick start

Requirements: Node 22+ and pnpm 9.

```bash
pnpm install
cp .dev.vars.example .dev.vars   # then set BETTER_AUTH_SECRET to a long random string
pnpm db:reset                    # apply migrations + seed local D1
pnpm exec wrangler login         # once; Vectorize + Workers AI run on your (free) account
pnpm exec wrangler vectorize create it-kb --preset=@cf/baai/bge-base-en-v1.5   # once, plus metadata indexes (see docs)
pnpm kb:ingest                   # embed kb/*.md into Vectorize + local D1
pnpm dev                         # http://localhost:5173 (API + app on one port)
```

Sign in with a seeded account — no real email needed locally. The 6-digit code is printed in the `pnpm dev` terminal (`[email:dev] … Your sign-in code is …`) unless `RESEND_API_KEY` is set.

| Role | Email |
|---|---|
| Employee | `ananya.sharma@minocy.example` (+7 more) |
| IT Agent | `arjun.mehta@minocy.example` (Network), `priya.nair@…` (Hardware), `rahul.verma@…` (Software), `sneha.iyer@…` (Identity & Access), `vikram.singh@…` (Collaboration) |
| IT Admin | `admin@minocy.example` |

## Scripts

| Command | What it does |
|---|---|
| `pnpm dev` | Vite + Cloudflare plugin: Worker, API and React app on one port |
| `pnpm build` | Production build (`dist/`) |
| `pnpm test` | Vitest inside the Workers runtime (Miniflare) |
| `pnpm typecheck` / `pnpm lint` | TypeScript project build / ESLint |
| `pnpm db:generate` | Generate a SQL migration from `src/db/schema.ts` |
| `pnpm db:migrate` / `pnpm db:seed` / `pnpm db:reset` | Apply migrations / seed / both, on local D1 |
| `pnpm kb:check` | Validate kb/*.md (frontmatter, sections, placeholders) |
| `pnpm kb:ingest [--force]` | Chunk + embed the KB into Vectorize and local D1 (skips unchanged articles) |
| `pnpm kb:search "query"` | Debug hybrid search from the terminal |
| `pnpm eval` | promptfoo evals → `evals/RESULTS.md` |
| `pnpm cf-typegen` | Regenerate `worker-configuration.d.ts` after editing `wrangler.jsonc` |

## Layout

```
src/            Worker: index.ts (entry), api/ (Hono), db/ (Drizzle schema), lib/auth.ts (Better Auth), email/
web/src/        React 19 + TanStack Router/Query + Tailwind v4 (Option B design tokens in styles.css)
migrations/     D1 migrations (drizzle-kit)
src/rag/        kb-sections.ts (parse + chunk), embed.ts, rrf.ts, search.ts (hybrid search)
kb/             20 knowledge base articles (markdown + frontmatter)
scripts/        seed.ts, check-kb.ts, ingest-kb.ts, search-kb.ts, eval.ts
evals/          promptfoo suites (retrieval.yaml) + providers/
tests/          Vitest in the Workers pool
```

## Stack

Cloudflare Workers · Hono + Zod · D1 + Drizzle · Better Auth (email OTP) · React 19 + Vite · TanStack Router & Query · Tailwind CSS v4 · Vitest (Workers pool) · Vectorize + Workers AI embeddings (bge-base-en-v1.5) · promptfoo. Coming next: Agents SDK + AI SDK with Gemini via AI Gateway (Phase 3), Durable Objects + Workflows + Email (Phases 4–5).

### One-time Vectorize metadata indexes

```bash
for p in "category string" "section string" "os_windows boolean" "os_macos boolean" "os_linux boolean"; do
  set -- $p; pnpm exec wrangler vectorize create-metadata-index it-kb --property-name=$1 --type=$2
done
```
