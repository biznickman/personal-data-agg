# Ingestion Engine Spec

## Overview
A Next.js + Inngest application that handles deterministic data ingestion. APIs -> Supabase, with optional LLM normalization for `x-news` clustering inputs. Each data source is an Inngest function in its own subfolder.

## Architecture
- **Framework:** Next.js (App Router, TypeScript)
- **Scheduler:** Inngest (cron-based functions with retries, observability)
- **Database:** Supabase (REST API via @supabase/supabase-js)
- **Env:** `.env.local` has SUPABASE_URL, SUPABASE_KEY, TWITTERAPI_IO_KEY

## Current Structure
```
src/
├── app/
│   ├── api/inngest/route.ts  ← Inngest serve endpoint
│   ├── api/x-news/stories/route.ts ← latest clustered stories JSON
│   ├── api/x-news/cluster/backfill/route.ts ← one-click cluster backfill trigger
│   ├── news/page.tsx         ← story explorer + backfill control
│   └── page.tsx              ← dashboard
├── inngest/
│   ├── client.ts             ← Inngest client (id: "ingestion-engine")
│   ├── functions.ts          ← parent file exporting all functions
│   ├── x-news/              ← X/Twitter news monitoring
│   │   ├── index.ts
│   │   ├── 1-ingest/
│   │   │   ├── ingest.ts      ← polls source accounts every 15min
│   │   │   ├── keywords.ts    ← crypto keyword search hourly
│   │   │   ├── twitter-api.ts ← shared Twitter API helpers
│   │   │   ├── sources.ts     ← reads source accounts from markdown
│   │   │   └── assets.ts      ← parses/upserts images, videos, URLs
│   │   ├── 2-enrich/
│   │   │   ├── enrich-urls.ts ← fetches readable content for parsed URLs
│   │   │   ├── normalize.ts   ← normalizes tweet text + URL context into headline/facts
│   │   │   ├── normalize-llm.ts ← OpenRouter/Portkey routing for normalization
│   │   │   └── url-content.ts ← readability extraction logic
│   │   └── 3-cluster/
│   │       ├── assign.ts      ← event-driven cluster assignment
│   │       ├── backfill.ts    ← event-driven historical replay enqueue
│   │       ├── merge.ts       ← periodic duplicate-cluster merge
│   │       ├── tokenize.ts    ← canonical text tokenization + similarity
│   │       └── cluster-db.ts  ← story-candidate thresholds + promo/spam gating
│   ├── granola/             ← Meeting notes
│   │   ├── index.ts
│   │   └── ingest.ts        ← syncs Granola notes every 30min
│   └── messages/            ← Message log
│       ├── index.ts
│       └── ingest.ts        ← extracts Nick's messages from JSONL transcripts every 30min
└── lib/
    └── supabase.ts          ← shared Supabase client
```

## Current Focus

- Keep `x-news` fully event-driven through ingest -> URL enrich -> normalize -> cluster assign.
- Use lightweight token-set clustering first; add embeddings only if quality stalls.
- Publish latest story candidates from `x_news_clusters` via `/api/x-news/stories`.
- Support on-demand backfill through `/api/x-news/cluster/backfill`.

## Supabase Tables (existing)
- `tweets` — tweet_id (text, unique), tweet_time, username, link, tweet_text, raw (jsonb), impressions, likes, quotes, retweets, bookmarks, replies, is_retweet, is_reply, is_quote, is_breakout, canonical_tweet_id, is_latest_version, normalized_headline (text), normalized_facts (jsonb)
- `tweet_images` — tweet_id, image_url, warrants_financial_analysis, image_category, initial_claude_analysis, summary, claude_summary_payload
- `tweet_urls` — tweet_id, url, url_content, raw_url_content
- `tweet_videos` — tweet_id (FK → tweets.id), preview_image_url, duration_ms, media_key, url_320, url_480, url_720, url_1080, raw_variants
- `voice_notes` — granola_id (text, unique), title, created_at, notes_text, transcript
- `message_log` — message_hash (text, unique), timestamp, message_text, session_key, category

## Twitter API (twitterapi.io)
- Base: https://api.twitterapi.io/twitter
- Auth: X-API-Key header
- Rate limit: 1 request per 5 seconds (free tier)
- Endpoint: /tweet/advanced_search?query=...&queryType=Latest

## Key Constraints
- The sources.ts file reads from ~/clawd/research/x-news-sources.md (symlinked workspace)
- The messages ingest reads JSONL files from ~/.openclaw/agents/*/sessions/
- Granola auth comes from ~/Library/Application Support/Granola/supabase.json
- All of these are local paths — this runs on a Mac mini, not deployed to cloud
