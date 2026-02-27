# CLAUDE.md

## Project Overview

**Ingestion Engine** — a Next.js + Inngest application that ingests data from multiple sources into Supabase. The primary focus is **X/Twitter news monitoring**: polling accounts, enriching URLs, normalizing tweets via LLM, generating embeddings, and clustering them into news stories. Secondary data sources include Granola meeting notes, message logs from OpenClaw transcripts, Slack workspace messages, and the owner's own X posts (@chooserich).

This runs on a local Mac mini, not deployed to cloud. All ingestion reads from local paths or external APIs and writes to a hosted Supabase instance.

## Stack

- **Framework:** Next.js 16 (App Router, TypeScript, React 19)
- **Scheduler:** Inngest (cron-based + event-driven functions with retries)
- **Database:** Supabase (REST API via `@supabase/supabase-js`)
- **Styling:** Tailwind CSS v4 (PostCSS plugin)
- **LLM Normalization:** OpenRouter or Portkey (Claude 3.5 Haiku default)
- **Embeddings:** Google Gemini (`gemini-embedding-001`)
- **Package manager:** pnpm
- **Build:** `next build --webpack` (webpack mode for compatibility)
- **Linting:** ESLint 9 with `eslint-config-next` (core-web-vitals + TypeScript)

## Quick Commands

```bash
pnpm install              # install dependencies
pnpm dev                  # start Next.js dev server (port 3000)
pnpm inngest              # start Inngest dev server (port 8288)
pnpm dev:all              # run both concurrently
pnpm build                # production build (webpack mode)
pnpm lint                 # run eslint
```

### Evaluation scripts (CommonJS, run with `node`):

```bash
pnpm stories:scan                   # scan story data
pnpm stories:cluster-eval           # threshold metrics comparison
pnpm stories:cluster-compare        # lexical vs embedding comparison
pnpm stories:embedding-preview      # embedding sweep + preview generation
pnpm stories:stability-eval         # cluster stability evaluation
pnpm stories:cluster-audit          # cluster audit
pnpm stories:embedding-eval         # embedding cluster evaluation
```

## Project Structure

```
src/
├── app/                            # Next.js App Router
│   ├── _components/                # Shared UI components (site header, story cards, sidebar)
│   ├── api/
│   │   ├── health/route.ts         # Health endpoint
│   │   ├── inngest/route.ts        # Inngest serve endpoint (registers all functions)
│   │   └── x-news/                 # X-news API routes
│   │       ├── admin/session/      # Admin auth session
│   │       ├── cluster/backfill/   # Cluster backfill trigger
│   │       └── stories/            # Stories JSON API + feedback + preview
│   ├── news/                       # Story explorer pages
│   │   ├── page.tsx                # Main news explorer
│   │   ├── preview/page.tsx        # Embedding preview page
│   │   └── review/page.tsx         # Admin review page (requires token)
│   ├── status/page.tsx             # Status dashboard
│   ├── page.tsx                    # Homepage (ranked + newest stories)
│   ├── layout.tsx                  # Root layout
│   └── globals.css                 # Global styles + CSS variables
├── inngest/
│   ├── client.ts                   # Inngest client (id: "ingestion-engine")
│   ├── functions.ts                # Re-exports all Inngest functions
│   ├── run-status.ts               # Best-effort run tracking to ingestion_runs table
│   ├── x-news/                     # X/Twitter news pipeline (primary focus)
│   │   ├── index.ts                # Barrel export for x-news functions
│   │   ├── 1-ingest/               # Stage 1: Fetch tweets
│   │   │   ├── accounts.ts         # Poll source accounts (15min cron)
│   │   │   └── keywords.ts         # Keyword search (hourly cron)
│   │   ├── 2-enrich/               # Stage 2: Enrich + normalize
│   │   │   └── preprocess.ts       # Consolidated orchestrator: URL enrich → image classify/summarize → LLM normalize → embed
│   │   ├── 3-cluster/              # Stage 3: Cluster management
│   │   │   ├── sync.ts             # RPC-based clustering sync (10min cron)
│   │   │   ├── backfill.ts         # Historical replay enqueue
│   │   │   ├── review.ts           # LLM cluster review
│   │   │   ├── curate.ts           # LLM cluster curation
│   │   │   ├── embeddings.ts       # Gemini embedding generation
│   │   │   ├── tokenize.ts         # Token-set similarity
│   │   │   └── vector.ts           # Vector utilities
│   │   ├── models/                 # Supabase table access (static class methods)
│   │   │   ├── tweets.ts           # TweetsModel
│   │   │   ├── tweet-assets.ts     # TweetAssetsModel
│   │   │   ├── tweet-urls.ts       # TweetUrlsModel
│   │   │   ├── tweet-images.ts     # TweetImagesModel
│   │   │   └── tweet-videos.ts     # TweetVideosModel
│   │   ├── services/               # External API integrations
│   │   │   ├── twitterapi-io.ts    # TwitterAPI.io client
│   │   │   ├── url-content.ts      # URL readability extraction
│   │   │   ├── story-normalizer.ts # LLM normalization (OpenRouter/Portkey)
│   │   │   └── image-analyzer.ts   # Image classification/summarization
│   │   ├── operations/             # Shared pipeline operations
│   │   │   └── fetch-tweets.ts     # Batched tweet fetching
│   │   └── utils/                  # Helpers
│   │       ├── env.ts              # getRequiredEnv()
│   │       ├── normalize-prompt.ts # Normalization prompt templates
│   │       ├── tweets.ts           # Tweet dedup/parsing helpers
│   │       └── asset-parser.ts     # Tweet media parsing
│   ├── granola/                    # Granola meeting notes (30min cron)
│   ├── messages/                   # OpenClaw transcript messages (30min cron)
│   ├── slack/                      # Slack workspace messages (10min cron)
│   └── x-posts/                    # Owner's X posts (@chooserich)
│       ├── fetch-recent.ts         # Fetch recent posts
│       ├── update-analytics.ts     # Update post analytics
│       └── archive-posts.ts        # Archive old posts
└── lib/
    ├── supabase.ts                 # Shared Supabase client singleton
    ├── x-news-stories.ts           # Story query/ranking logic (getLatestXNewsStories, getHomepageStories)
    ├── x-news-accounts.ts          # Blocked account list
    ├── x-news-admin.ts             # Admin token verification
    └── monitoring.ts               # Monitoring helpers

scripts/                            # CommonJS evaluation/audit scripts
supabase/migrations/                # SQL migrations (timestamped)
docs/                               # Additional documentation
```

## Architecture: X-News Pipeline

The core pipeline is event-driven through Inngest:

```
1. INGEST  (cron) → poll Twitter accounts/keywords → upsert tweets + assets
       ↓ sends "x-news/tweet.preprocess" events
2. PREPROCESS (event) → enrich URLs → classify/summarize images → LLM normalize → generate embedding
       ↓ (embedding stored on tweet row)
3. CLUSTER SYNC (cron) → RPC-based embedding clustering → match/create persistent clusters → emit review events
       ↓ sends "x-news/cluster.review.requested" events
4. REVIEW  (event) → LLM reviews new/updated clusters
5. CURATE  (event) → LLM curates cluster quality
```

## Code Conventions

### TypeScript
- **Strict mode** enabled (`tsconfig.json`)
- Path alias: `@/*` maps to `./src/*`
- Target: ES2022

### Inngest Functions
- Each function uses `inngest.createFunction()` with an explicit `id`, `retries`, and optional `concurrency`/`timeouts`
- Functions use `step.run("step-name", async () => {...})` for durable execution
- Inter-function communication via `step.sendEvent()` with typed event names (e.g., `"x-news/tweet.preprocess"`)
- Every function follows try/catch with `recordFunctionRun()` for both success and failure tracking
- Cron functions return a summary object with status and counts

### Database Models
- Models are static classes (e.g., `TweetsModel.upsertReturningRefs(...)`)
- All Supabase queries use the shared client from `@/lib/supabase`
- Batch operations chunk by 50-300 rows to avoid query limits
- Upserts use `onConflict` with natural keys (tweet_id, slack_message_id, etc.)

### Environment Variables
- Use `getRequiredEnv(name)` from `src/inngest/x-news/utils/env.ts` for required vars
- Use inline `process.env.X_*` with fallback defaults for optional config
- Copy `.env.local.example` to `.env.local` for local development
- Never commit `.env.local` (gitignored)

### Frontend
- React Server Components by default (`export const dynamic = "force-dynamic"` for data-fetching pages)
- CSS variables for theming (prefixed `--tm-*`)
- Tailwind CSS v4 utility classes
- No client-side state management library

### Error Handling
- Inngest functions: try/catch wrapping the entire function body, recording failure via `recordFunctionRun()`
- Service calls: throw on non-OK HTTP responses with status + body text
- Supabase: check `.error` after every query, throw descriptive `Error`

## Supabase Tables

Key tables:
- `tweets` — ingested tweets with normalization columns and embedding
- `tweet_images`, `tweet_urls`, `tweet_videos` — parsed tweet assets
- `x_news_clusters` — persistent news clusters with stats
- `x_news_cluster_tweets` — cluster membership (tweet_id FK → tweets.id)
- `x_news_cluster_feedback` — operator feedback on clusters
- `voice_notes` — Granola meeting notes
- `message_log` — OpenClaw transcript messages
- `slack_messages` — Slack channel messages
- `ingestion_runs` — function run status tracking

Migrations live in `supabase/migrations/` with timestamp prefixes.

## Key URLs (local dev)

- App: `http://localhost:3000`
- Inngest dashboard: `http://localhost:8288`
- Inngest serve: `http://localhost:3000/api/inngest`
- Health: `http://localhost:3000/api/health`
- Stories API: `http://localhost:3000/api/x-news/stories?hours=24&limit=20`
- News explorer: `http://localhost:3000/news`
- Admin review: `http://localhost:3000/news/review`

## Important Notes

- **No test suite exists.** There are no unit or integration tests in this repo.
- **No CI/CD pipeline.** This runs locally on a Mac mini.
- **Build uses webpack mode** (`next build --webpack`) for compatibility in restricted environments.
- **External API rate limits:** TwitterAPI.io has a 1 req/5s free-tier limit; tweet fetching uses batched delays (`FETCH_BATCH_DELAY_MS = 5500`).
- **Source accounts** are hardcoded in `src/inngest/x-news/1-ingest/accounts.ts` as a `SOURCES` array.
- **Blocked accounts** are managed in `src/lib/x-news-accounts.ts`.
- The RPC function `cluster_tweets_by_embedding` runs in Supabase/Postgres for server-side vector clustering.
- Evaluation scripts in `scripts/` are CommonJS (`.cjs`) and write output to `scripts/output/`.
