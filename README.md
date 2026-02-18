# Ingestion Engine

Deterministic ingestion service built with Next.js + Inngest.  
No AI or browser automation: local files/APIs -> Supabase tables.

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

## Inngest Functions

- `x-news-ingest` (`*/15 * * * *`) -> `tweets`
- `x-keyword-scan` (`0 * * * *`) -> `tweets` (`topic = "keywords"`)
- `granola-ingest` (`*/30 * * * *`) -> `voice_notes`
- `message-log-ingest` (`*/30 * * * *`) -> `message_log`

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
