# Personal Data Migration Plan

Extract personal data ingestion (Slack, Granola, X Posts) from `ingestion-engine` into a standalone Next.js + Inngest project.

---

## Components to Migrate

| Component | Source Dir | Cron Schedule | DB Tables |
|-----------|-----------|---------------|-----------|
| Granola (meeting notes) | `src/inngest/granola/` | Every 30 min | `voice_notes` |
| Slack messages | `src/inngest/slack/` | Every 10 min | `slack_messages` |
| X Posts (@chooserich) | `src/inngest/x-posts/` | 15 min / 4 hrs | `x_posts` |

**Shared tables also needed:** `ingestion_runs`, `app_settings`

---

## Task List

### 1. New Project Scaffolding

- [ ] Create a new repo (e.g. `personal-ingestion`)
- [ ] Initialize Next.js + TypeScript project
- [ ] Set up Inngest integration (`/api/inngest` serve endpoint)
- [ ] Install shared dependencies: `@supabase/supabase-js`, `inngest`, `dotenv`
- [ ] Install component-specific dependencies:
  - Granola: none beyond fetch
  - Slack: none beyond fetch (raw HTTP to Slack API)
  - X Posts: `twitter-api-v2`
- [ ] Set up `.env.local` with relevant environment variables (see section below)

### 2. Database Setup

- [ ] **Decision: same Supabase project or separate?**
  - **Option A — Same Supabase project, separate schema:** Create a `personal` schema in the existing Supabase DB. Move/rename the personal tables into that schema. Both apps share a DB but have clear boundaries.
  - **Option B — Separate Supabase project:** Spin up a new Supabase project. Migrate table definitions + data. Full isolation but requires its own billing/plan.
  - **Option C — Same project, same schema, just different app code:** Keep tables where they are; only move the application code. Simplest migration but no DB-level separation.
- [ ] Create migration files for personal tables in the new project:
  - `voice_notes` (granola_id PK, title, created_at, notes_text, transcript)
  - `slack_messages` (slack_message_id PK, channel_id, channel_name, message_ts, user_id, bot_id, message_type, subtype, is_thread_parent, reply_count, message_text, raw JSONB, message_time)
  - `x_posts` (tweet_id PK, username, tweet_time, link, tweet_text, likes, retweets, quotes, bookmarks, replies, impressions, analytics_updated_at)
  - `ingestion_runs` (function_id, status, last_run_at, details, error_message)
  - `app_settings` (setting_key, setting_value, is_secret, description)
- [ ] If using a separate DB: export existing data from the current tables and import into the new project
- [ ] Reference the existing Supabase migrations for exact column types/constraints:
  - Key migrations to review: `supabase/migrations/` — look at any that create the personal tables listed above

### 3. Copy & Adapt Ingestion Functions

#### 3a. Granola Ingest
- [ ] Copy `src/inngest/granola/ingest.ts` and `index.ts`
- [ ] Copy or recreate the Supabase client helper (`src/lib/supabase.ts`)
- [ ] Verify OAuth token refresh logic works standalone (uses `app_settings` table)
- [ ] Register the `granola-ingest` Inngest function in the new project's Inngest client

#### 3b. Slack Ingest
- [ ] Copy `src/inngest/slack/ingest.ts` and `index.ts`
- [ ] Register the `slack-ingest` Inngest function
- [ ] Move Slack-specific env vars: `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_IDS`, `SLACK_LOOKBACK_MINUTES`, `SLACK_MAX_PAGES_PER_CHANNEL`

#### 3c. X Posts
- [ ] Copy `src/inngest/x-posts/` (all files: `fetch-recent.ts`, `update-analytics.ts`, `archive-posts.ts`, `twitter-service.ts`, `format-tweet.ts`)
- [ ] Register all X Posts Inngest functions (`x-posts-fetch-recent`, `x-posts-update-analytics`)
- [ ] Move Twitter env vars: `TWITTER_BEARER_TOKEN`, `TWITTER_API_KEY`, `TWITTER_API_SECRET`, `TWITTER_ACCESS_TOKEN`, `TWITTER_ACCESS_SECRET`

### 4. Update Shared Infrastructure

- [ ] Copy `src/lib/supabase.ts` (Supabase client initialization)
- [ ] Adapt `src/lib/monitoring.ts` — strip out all news-aggregator function references; keep only the personal function monitors:
  - `granola-ingest`
  - `slack-ingest`
  - `x-posts-fetch-recent`
  - `x-posts-update-analytics`
- [ ] Create a simple `/api/health` endpoint in the new project using the adapted monitoring
- [ ] Set up the Inngest client with just the personal functions

### 5. Clean Up `ingestion-engine` (This Repo)

- [ ] Remove `src/inngest/granola/`
- [ ] Remove `src/inngest/slack/`
- [ ] Remove `src/inngest/messages/` (OpenClaw message log — dropping entirely)
- [ ] Remove `src/inngest/x-posts/`
- [ ] Remove personal functions from the Inngest client registration (wherever functions are gathered and served)
- [ ] Remove personal function references from `src/lib/monitoring.ts`
- [ ] Remove unused environment variables from `.env.local.example`
- [ ] Remove `twitter-api-v2` from `package.json` (only needed for personal X Posts; news uses TwitterAPI.io)
- [ ] If using a separate DB: drop the personal tables via a new migration
- [ ] Drop `message_log` table (OpenClaw — no longer needed in either project)
- [ ] Update the health endpoint to only monitor news functions
- [ ] Verify the news pipeline still works end-to-end after removal

### 6. Environment Variables for New Project

```
# Supabase
SUPABASE_URL=
SUPABASE_KEY=

# Inngest
INNGEST_EVENT_KEY=
INNGEST_SIGNING_KEY=

# Granola
GRANOLA_MCP_ACCESS_TOKEN=
GRANOLA_MCP_REFRESH_TOKEN=
GRANOLA_MCP_CLIENT_ID=

# Slack
SLACK_BOT_TOKEN=
SLACK_CHANNEL_IDS=
SLACK_LOOKBACK_MINUTES=240
SLACK_MAX_PAGES_PER_CHANNEL=10

# Twitter (personal posts)
TWITTER_BEARER_TOKEN=
TWITTER_API_KEY=
TWITTER_API_SECRET=
TWITTER_ACCESS_TOKEN=
TWITTER_ACCESS_SECRET=
```

### 7. Deployment & Operations

- [ ] Decide where the new project will run (Vercel, Railway, local, etc.)
- [ ] Configure Inngest Cloud (or self-hosted Inngest dev server) for the new project's functions
- [ ] Verify all cron schedules are firing correctly in the new project
- [ ] Set up alerting/monitoring for the new project's health endpoint
- [ ] If both projects share a DB: ensure no write conflicts on `ingestion_runs` or `app_settings`

### 8. Validation Checklist

- [ ] Granola ingest runs and populates `voice_notes`
- [ ] Slack ingest runs and populates `slack_messages`
- [ ] X Posts fetch runs and populates `x_posts`
- [ ] X Posts analytics update runs
- [ ] Health endpoint reports all functions as healthy
- [ ] `ingestion-engine` news pipeline is unaffected (stories still cluster, UI still works)
- [ ] No orphaned environment variables in either project

---

## Open Questions

1. **Same DB or separate DB?** Sharing the existing Supabase project is simplest (Option C) but doesn't give full isolation. A separate schema (Option A) is a good middle ground.
2. **Does the new project need a UI?** The personal data currently has no dedicated UI in `ingestion-engine`. Next.js is ready for when you want to add dashboards.
