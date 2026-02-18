# Migration Spec: InternalX → Ingestion Engine

## Goal
Migrate the X/Twitter own-post ingestion code from `~/Dev/internalx/` into this ingestion engine.
This adds the ability to fetch Nick's (@chooserich) tweets and their analytics via the X API v2,
storing them in the `x_posts` Supabase table.

## Source Code (~/Dev/internalx/)
The following files contain reusable code:

### Must migrate (adapt to our patterns):
- `src/services/twitter.ts` — TwitterService class using `twitter-api-v2` library. Handles:
  - Bearer token + OAuth auth
  - Recent search + full-archive search with fallback
  - Pagination with rate limit handling
  - `fetchOriginalPostsFromUsers()` — fetch tweets by username
  - `fetchTweetAnalyticsByIds()` — fetch public metrics for tweet IDs in batches of 100
  - `fetchUserTimeline()` — fetch user timeline (up to 3200 tweets)
  - `fetchFollowerCountsForUsernames()` — get follower counts
  - Media enrichment (attaches media + author to tweets)

- `src/operations/fetchTweets.ts` — `formatTweet()` function that:
  - Transforms API response to DB format
  - Detects format (text/photo/video/spaces/mixed/animated_gif)
  - Handles edited tweets (canonical_tweet_id)
  - Extracts public_metrics (impressions, likes, retweets, quotes, bookmarks, replies)
  - Skips retweets, keeps replies and quotes

### Create new Inngest functions:
1. **`src/inngest/x-posts/fetch-recent.ts`** — Cron every 15 min
   - Fetch @chooserich tweets from last 30 min (overlap for safety)
   - Format and upsert to `x_posts` table in our Supabase
   - Adapted from InternalX's `fetchRecentTweets.ts`

2. **`src/inngest/x-posts/update-analytics.ts`** — Cron every 4 hours
   - Find x_posts where analytics_updated_at is NULL and tweet is >72h old
   - Fetch current public_metrics via API
   - Update impressions, likes, retweets, quotes, bookmarks, replies, analytics_updated_at
   - Adapted from InternalX's `updateTweetAnalytics.ts`

3. **`src/inngest/x-posts/index.ts`** — Exports both functions

## Key Differences from InternalX

### Database
- InternalX uses Supabase at `bxhdximflvyolbxxyuya.supabase.co` with `@supabase/supabase-js`
- We use Supabase at `nepyndfezgcmvdqkatfp.supabase.co` — same client lib
- InternalX has separate tables: `tweets`, `tweet_images`, `tweet_videos`, `tweet_urls`, `tweet_users`
- We have a single flat `x_posts` table (no separate media tables)

### x_posts table schema (already created in Supabase):
```
tweet_id TEXT UNIQUE NOT NULL
tweet_text TEXT
tweet_time TIMESTAMPTZ
username TEXT DEFAULT 'chooserich'
format TEXT  -- 'text', 'photo', 'video', 'mixed', 'animated_gif', 'spaces'
impressions BIGINT DEFAULT 0
likes INT DEFAULT 0
retweets INT DEFAULT 0
quotes INT DEFAULT 0
bookmarks INT DEFAULT 0
replies INT DEFAULT 0
view_count BIGINT DEFAULT 0
url_clicks INT
profile_clicks INT
playback_0 INT, playback_25 INT, playback_50 INT, playback_75 INT, playback_100 INT
link TEXT
is_reply BOOLEAN DEFAULT FALSE
is_quote BOOLEAN DEFAULT FALSE
is_retweet BOOLEAN DEFAULT FALSE
is_latest_version BOOLEAN DEFAULT TRUE
canonical_tweet_id TEXT
analytics_updated_at TIMESTAMPTZ
created_at TIMESTAMPTZ DEFAULT NOW()
raw JSONB
```

### Simplifications
- We only track @chooserich (single user, not multi-user)
- No separate image/video/URL tables — just store format type and raw JSON
- No Active Record models — just direct Supabase client calls
- No archiveUserTweets (historical archival) — data already backfilled
- Use existing `src/lib/supabase.ts` for the Supabase client

### Environment Variables
Add to `.env.local`:
- `TWITTER_BEARER_TOKEN` — from ~/Dev/internalx/.env
- `TWITTER_ACCESS_TOKEN` — from ~/Dev/internalx/.env (for future OAuth)
- `TWITTER_ACCESS_SECRET` — from ~/Dev/internalx/.env (for future OAuth)
- `TWITTER_CLIENT_ID` — from ~/Dev/internalx/.env (for future OAuth)
- `TWITTER_CLIENT_SECRET` — from ~/Dev/internalx/.env (for future OAuth)

### Package dependency
Add `twitter-api-v2` to package.json: `npm install twitter-api-v2`

## File Structure After Migration
```
src/inngest/
├── x-posts/
│   ├── index.ts           ← exports both functions
│   ├── fetch-recent.ts    ← cron: fetch new tweets every 15 min
│   ├── update-analytics.ts ← cron: update metrics every 4 hours
│   ├── twitter-service.ts  ← adapted from InternalX's twitter.ts (simplified)
│   └── format-tweet.ts     ← adapted from InternalX's fetchTweets.ts formatTweet()
```

## What to simplify from InternalX's TwitterService
- Remove `fetchOriginalPostsFromUserIds()` (we use usernames)
- Remove `fetchOriginalPostsPage()` (we don't need paginated single-user fetch)
- Remove `fetchUserTimeline()` (not needed for ongoing ingestion)
- Remove `fetchUserByUsername()` and `fetchUserById()` (not needed)
- Keep `fetchOriginalPostsFromUsers()` — main tweet fetcher
- Keep `fetchTweetAnalyticsByIds()` — for analytics updates
- Keep `fetchFollowerCountsForUsernames()` — useful for growth tracking
- Keep rate limit handling and pagination logic
- Keep media enrichment

## What to simplify from formatTweet
- Remove image/video/URL extraction (we don't have separate tables)
- Keep format detection (text/photo/video/spaces/mixed/animated_gif)
- Keep public_metrics extraction
- Keep retweet filtering
- Keep edited tweet handling (canonical_tweet_id)
- Map directly to x_posts schema instead of InternalX's tweet schema

## Run status tracking
Use the existing `src/inngest/run-status.ts` to log runs to `ingestion_runs` table.

## Register functions
Add the new functions to `src/inngest/functions.ts`.

## After migration, verify:
- `npm run build` passes
- Both new Inngest functions are registered
- Types are correct (no `any` where avoidable)
