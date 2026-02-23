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
- `SCRAPINGBEE_API_KEY` (optional; used as fallback for URL extraction when direct fetch is blocked)
- `X_NEWS_NORMALIZER_PROVIDER` (`openrouter` or `portkey`)
- `X_NEWS_NORMALIZER_MODEL` (default: provider-specific Haiku model)
- `OPENROUTER_API_KEY` (required when provider = `openrouter`)
- `PORTKEY_API_KEY` (required when provider = `portkey`)
- `PORTKEY_CONFIG` (optional; Portkey config ID)
- `PORTKEY_BASE_URL` (optional; defaults to `https://api.portkey.ai/v1`)
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
```

## Inngest Functions

- `x-news-ingest` (`*/15 * * * *`) -> `tweets`
- `x-keyword-scan` (`0 * * * *`) -> `tweets`
- `x-news-enrich-urls` (`event: x-news/url.enrich`) -> enriches `tweet_urls.url_content`
- `x-news-normalize` (`event: x-news/tweet.normalize`) -> writes `tweets.normalized_headline` + `tweets.normalized_facts`
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
- `src/inngest/x-news/3-cluster/` -> reserved for clustering pipeline

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
