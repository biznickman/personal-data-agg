# Ingestion Engine

Deterministic ingestion service built with Next.js + Inngest.  
Local APIs -> Supabase tables, with optional LLM-based tweet normalization for clustering.

## Stack

- Next.js (App Router, TypeScript)
- Inngest (cron scheduling + retries)
- Supabase (`@supabase/supabase-js`)

## Environment

Copy `.env.local.example` to `.env.local` and set:

- `SUPABASE_URL`
- `SUPABASE_KEY`
- `TWITTERAPI_IO_KEY`
- `INNGEST_DEV_URL` (optional, defaults to `http://localhost:8288`)
- `INNGEST_EVENT_KEY` (required for API-triggered backfill/events outside Inngest steps)
- `SCRAPINGBEE_API_KEY` (optional; used as fallback for URL extraction when direct fetch is blocked)
- `X_NEWS_NORMALIZER_PROVIDER` (`openrouter` or `portkey`)
- `X_NEWS_NORMALIZER_MODEL` (default: provider-specific Haiku model)
- `OPENROUTER_API_KEY` (required when provider = `openrouter`)
- `PORTKEY_API_KEY` (required when provider = `portkey`)
- `PORTKEY_CONFIG` (optional; Portkey config ID)
- `PORTKEY_BASE_URL` (optional; defaults to `https://api.portkey.ai/v1`)
- `X_NEWS_CLUSTER_SIMILARITY_MODE` (optional; `lexical` or `embedding`, default `lexical`)
- `X_NEWS_CLUSTER_ASSIGN_THRESHOLD` (optional; default `0.30`)
- `X_NEWS_CLUSTER_ASSIGN_THRESHOLD_EMBEDDING` (optional; default `0.76`)
- `X_NEWS_CLUSTER_ASSIGN_MIN_LEXICAL_OVERLAP_EMBEDDING` (optional; default `0.08`)
- `X_NEWS_CLUSTER_MERGE_THRESHOLD` (optional; default `0.45`)
- `X_NEWS_CLUSTER_MERGE_THRESHOLD_EMBEDDING` (optional; default `0.82`)
- `X_NEWS_CLUSTER_MERGE_MIN_LEXICAL_OVERLAP_EMBEDDING` (optional; default `0.08`)
- `X_NEWS_CLUSTER_TEXT_MODE` (optional; `headline_only` or `headline_and_facts`, default `headline_only`)
- `X_NEWS_CLUSTER_LOOKBACK_HOURS` (optional; default `48`)
- `X_NEWS_CLUSTER_MAX_CANDIDATES` (optional; default `200`)
- `X_NEWS_CLUSTER_MIN_TWEETS` (optional; default `3`)
- `X_NEWS_CLUSTER_MIN_USERS` (optional; default `2`)
- `GEMINI_API_KEY` (required when `X_NEWS_CLUSTER_SIMILARITY_MODE=embedding`)
- `X_NEWS_EMBED_MODEL` (optional; default `gemini-embedding-001`)
- `X_NEWS_EMBED_TASK_TYPE` (optional; default `CLUSTERING`)
- `X_NEWS_EMBED_DIMENSIONS` (optional; default `1536`)
- `X_NEWS_ADMIN_TOKEN` (required for admin review/feedback actions at `/news/review`)
- `SLACK_BOT_TOKEN` (bot token from your Slack app)
- `SLACK_CHANNEL_IDS` (comma-separated channel IDs to ingest, e.g. `C123...,C456...`)
- `SLACK_LOOKBACK_MINUTES` (optional, backfill window for first run; default `240`)
- `SLACK_MAX_PAGES_PER_CHANNEL` (optional, guardrail to cap per-run pagination; default `10`)

## Local Paths Used by Ingestors

- X sources markdown: `~/clawd/research/x-news-sources.md`
- OpenClaw transcripts: `~/.openclaw/agents/*/sessions/*.jsonl`
- Granola auth: `~/Library/Application Support/Granola/supabase.json`

## Run

```bash
npm install
npm run dev
```

Inngest serve endpoint: `http://localhost:3000/api/inngest`  
Dashboard: `http://localhost:3000`  
Health endpoint: `http://localhost:3000/api/health`

## Build

```bash
npm run build
```

Build uses webpack in this repo for compatibility in restricted environments.

## Schema Migrations

This repo keeps SQL migrations under `supabase/migrations/`.

Run these migrations:

```sql
-- supabase/migrations/20260222154000_add_tweets_normalization_columns.sql
alter table if exists public.tweets
  add column if not exists normalized_headline text,
  add column if not exists normalized_facts jsonb;

-- supabase/migrations/20260222164000_add_tweet_asset_tables.sql
-- creates tweet_images, tweet_urls, tweet_videos

-- supabase/migrations/20260222173000_add_slack_messages_table.sql
-- creates slack_messages for channel message ingestion

-- supabase/migrations/20260223120000_drop_tweets_topic_column.sql
-- removes legacy tweets.topic ingest-tag column

-- supabase/migrations/20260223123000_add_x_news_cluster_tables.sql
-- creates x_news_clusters, x_news_cluster_tweets, x_news_cluster_merges

-- supabase/migrations/20260223193000_add_x_news_embedding_columns.sql
-- adds tweets.normalized_headline_embedding + x_news_clusters.centroid_embedding

-- supabase/migrations/20260223233500_add_x_news_cluster_feedback_table.sql
-- adds x_news_cluster_feedback for operator voting/notes on clusters
```

## Inngest Functions

- `x-news-ingest` (`*/15 * * * *`) -> `tweets`
- `x-keyword-scan` (`0 * * * *`) -> `tweets`
- `x-news-enrich-urls` (`event: x-news/url.enrich`) -> enriches `tweet_urls.url_content`
- `x-news-normalize` (`event: x-news/tweet.normalize`) -> writes `tweets.normalized_headline` + `tweets.normalized_facts`
- `x-news-cluster-assign` (`event: x-news/tweet.normalized`) -> assigns normalized tweet to cluster (lexical or embedding mode)
- `x-news-cluster-merge` (`*/2 * * * *`) -> merges duplicate clusters (lexical or embedding mode)
- `x-news-cluster-backfill` (`event: x-news/cluster.backfill.requested`) -> re-queues historical normalized tweets for clustering
- `granola-ingest` (`*/30 * * * *`) -> `voice_notes`
- `message-log-ingest` (`*/30 * * * *`) -> `message_log`
- `slack-ingest` (`*/10 * * * *`) -> `slack_messages`

## Slack Setup Notes

Create and install a Slack app with a bot token (`xoxb-...`) and grant:

- `channels:read`
- `channels:history`
- `groups:read`
- `groups:history`

## Tweet Asset Tables

`x-news` now stores parsed tweet assets in:

- `tweet_images` (one row per image)
- `tweet_urls` (one row per expanded URL, plus extracted readable content)
- `tweet_videos` (video metadata/variants keyed to `tweets.id`)

## X-News Stages

- `src/inngest/x-news/1-ingest/` -> fetch tweets + parse/upsert media/urls/videos
- `src/inngest/x-news/2-enrich/` -> enrich URLs and normalize tweets into headline/facts
- `src/inngest/x-news/3-cluster/` -> assign + merge normalized-story clusters

## Story Output

- API: `/api/x-news/stories?hours=24&limit=20` (JSON latest clusters; defaults to story candidates only)
- Backfill API: `POST /api/x-news/cluster/backfill` (queues `x-news-cluster-backfill`)
  - `mode=unassigned` queues only normalized tweets not yet assigned
  - `mode=all` queues all normalized tweets (assigned rows will be skipped by assigner)
  - `mode=rebuild` clears existing clusters and replays all normalized tweets
- Story explorer page: `/news` (toggle story-candidates vs all clusters, adjustable window via query params)
- Admin review page: `/news/review` (feedback controls; requires admin token session)
- `/news` includes a one-click cluster backfill control
- Embedding preview page: `/news/preview` (reads latest offline embedding sweep output)
- Embedding preview JSON API: `/api/x-news/stories/preview`
- Feedback API: `POST /api/x-news/stories/feedback` (`label`: `useful`, `noise`, `bad_cluster`)
- Dashboard: `/` now includes a `Latest X News Clusters (24h)` section

## Cluster Evaluation

- Run side-by-side threshold metrics locally:
  - `pnpm stories:cluster-eval -- --hours 24 --limit 2000`
- Run lexical vs semantic-embedding comparison:
  - `pnpm stories:cluster-compare -- --hours 24 --limit 200 --provider openai --model text-embedding-3-small --dup-threshold 0.88`
- Run embedding threshold sweep + story preview file generation:
  - `pnpm stories:embedding-preview -- --hours 24 --limit 300 --provider openai --model text-embedding-3-small --text-mode headline_only`
  - Force a specific embedding config for quick manual validation:
    - `pnpm stories:embedding-preview -- --hours 24 --limit 300 --provider openai --model text-embedding-3-small --text-mode headline_only --assign-threshold 0.76 --merge-threshold 0.82`

## Optional Status Table

Functions write run state to `ingestion_runs` when present:

```sql
create table if not exists ingestion_runs (
  function_id text primary key,
  status text not null check (status in ('ok', 'error')),
  last_run_at timestamptz not null,
  details jsonb not null default '{}'::jsonb,
  error_message text
);
```
