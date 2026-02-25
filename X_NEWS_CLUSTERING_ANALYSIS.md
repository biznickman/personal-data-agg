# X News Clustering System — Analysis

## Table of Contents

- [System Overview](#system-overview)
- [Pipeline Architecture](#pipeline-architecture)
- [Flaws](#flaws)
- [Potential Misses](#potential-misses-tweets-not-being-embeddedclustered)
- [Improvement Opportunities](#improvement-opportunities)

---

## System Overview

**Tech Stack:** Next.js (App Router, TypeScript), Inngest (cron scheduler), Supabase (Postgres + pgvector), OpenRouter/Portkey (LLM normalization), Google Gemini (embeddings)

**Core Pipeline:**

```
Tweet Sources (TwitterAPI.io) → Ingest → URL Enrich → Normalize (LLM) → Cluster Assign → Cluster Merge
```

**Key Components:**

| Component | Path | Schedule |
|---|---|---|
| Account ingest | `src/inngest/x-news/1-ingest/accounts.ts` | Every 15 min |
| Keyword scan | `src/inngest/x-news/1-ingest/keywords.ts` | Hourly |
| URL enrichment | `src/inngest/x-news/2-enrich/` | Event-driven |
| Normalization | `src/inngest/x-news/2-enrich/normalize.ts` | Event-driven |
| Cluster assign | `src/inngest/x-news/3-cluster/assign.ts` | Event-driven |
| Cluster merge | `src/inngest/x-news/3-cluster/merge.ts` | Every 2 min |
| Stories API | `src/app/api/x-news/stories/` | On demand |

**Key Parameters:**

| Parameter | Default | Purpose |
|---|---|---|
| `ASSIGN_THRESHOLD` | 0.30 | Jaccard similarity to attach tweet to cluster |
| `ASSIGN_THRESHOLD_EMBEDDING` | 0.76 | Cosine similarity for embedding-based assignment |
| `MERGE_THRESHOLD` | 0.45 | Jaccard similarity to merge two clusters |
| `MERGE_THRESHOLD_EMBEDDING` | 0.82 | Cosine similarity for embedding-based merges |
| `LOOKBACK_HOURS` | 48 | How far back to search for candidate clusters |
| `MAX_CANDIDATES` | 200 | Max clusters considered per assignment |
| `MIN_TWEETS` | 3 | Minimum tweets for story candidate |
| `MIN_USERS` | 2 | Minimum unique users for story candidate |
| `SIMILARITY_MODE` | lexical | `lexical` (Jaccard) or `embedding` (cosine) |
| `TEXT_MODE` | headline_only | Whether facts are included in tokenization |

---

## Pipeline Architecture

### 1. Ingestion

- **Account ingest** polls 47 hardcoded crypto news sources every 15 minutes via TwitterAPI.io (batches of 8, 5.5s delay between batches).
- **Keyword scan** runs hourly with `min_faves:50` filter, English only, excluding retweets. Searches terms like "fed chair", "bitcoin", "ethereum", "solana", etc.
- Tweets are upserted by `tweet_id`. Assets (images, URLs, videos) are extracted into separate tables.

### 2. Enrichment & Normalization

- **URL enrichment:** Fetches linked URLs (30s timeout), falls back to ScrapingBee. Extracts readable content via Readability.
- **Normalization:** LLM (Claude 3.5 Haiku, temp=0) produces a `normalized_headline` (max 240 chars) and `normalized_facts` (max 12 items) from tweet text + up to 3 enriched URL contents.

### 3. Clustering

- **Tokenization:** Headline (optionally + facts) → lowercase → extract alphanumeric tokens → remove stopwords/short tokens → deduplicate → max 240 tokens.
- **Assignment:** Find best matching cluster from last 48h (max 200). If similarity ≥ threshold, attach; otherwise create new cluster.
- **Merging:** Every 2 minutes, scan all active clusters. If any pair exceeds merge threshold, merge smaller/newer into larger/older.
- **Story candidacy:** Cluster needs ≥3 tweets from ≥2 unique users, passes promo/spam filter and low-information filter.

### 4. Embedding (optional)

- Only active when `SIMILARITY_MODE=embedding`.
- Uses Gemini `gemini-embedding-001`, 1536 dimensions, task type `CLUSTERING`.
- Embeds only the `normalized_headline` — facts are excluded.
- Centroid updated incrementally via weighted average on each assignment/merge.

---

## Flaws

### 1. Centroid Drift from Incremental Updates

The cluster centroid embedding is updated as a weighted average each time a new tweet is assigned, rather than being recomputed from all member tweets. Over time, especially after merges, the centroid drifts from the true center of the cluster — causing tweets that should match to miss, and edge-case tweets to incorrectly attach.

### 2. Only the Headline is Embedded, Not Facts

In embedding mode, only `normalized_headline` is sent to Gemini. The `normalized_facts` array (which often carries the most differentiated information) is ignored for semantic similarity. Two tweets about different events could have similar headlines ("Bitcoin drops amid market turmoil") but very different facts.

### 3. Merge Direction Heuristic is Fragile

Merge direction is: higher tweet count → older `first_seen_at` → lower ID. A large, older, less-relevant cluster can absorb a newer, more accurate one — overwriting its headline and diluting its facts. There's no quality or recency weighting.

### 4. Normalization is Not Idempotent

Re-running normalization overwrites the previous headline/facts with no versioning. If the LLM produces a worse result on retry (e.g., during a backfill), cluster quality silently degrades with no rollback path.

### 5. Aggressive Promo/Spam Filter in Crypto Context

Blacklisted terms like "airdrop", "claim", "wallet" are core crypto vocabulary. Legitimate stories ("Arbitrum announces $ARB airdrop", "Coinbase Wallet adds new feature") may be filtered as spam. The binary filter doesn't account for source reputation.

### 6. No Concurrency Control on Normalization or URL Enrichment

Cluster assignment is capped at 5 concurrent and merge at 1, but normalization and URL enrichment have no explicit limits. A tweet burst could overwhelm the LLM provider or scraping service.

### 7. Hard 48-Hour Lookback Boundary

Stories developing over >48 hours split into separate clusters. A regulatory story that leaks Monday and confirms Wednesday won't merge because the original cluster aged out.

---

## Potential Misses (Tweets Not Being Embedded/Clustered)

### 1. Empty Headline → Silent Drop

If the LLM returns an empty `normalized_headline` (or tweet text is missing), the tweet is skipped from clustering with reason `"empty_normalized_content"`. No retry, no fallback to raw text.

### 2. URL Enrichment Failures Can Block the Pipeline

If URL enrichment never completes (Inngest retry exhaustion), the tweet may never trigger normalization. Even when enrichment partially fails, the normalization proceeds with less context, producing weaker headlines.

### 3. Only 47 Hardcoded Sources

The account list is static. New analysts, outlets, or emerging voices won't be picked up unless someone manually edits `accounts.ts`. No mechanism for discovering or suggesting new sources.

### 4. High Engagement Floor on Keyword Scan

`min_faves:50` means early-breaking news from smaller accounts is invisible until it's already viral. A credible but niche account breaking news first won't enter the system.

### 5. Quote Tweet Content is Ignored

`quoted_tweet` data exists in `raw` but is never used during normalization. If someone quote-tweets breaking news with commentary, only their commentary is normalized — the original news is lost. The system may build clusters of *reactions* without the *source*.

### 6. Reply Threads Are Invisible

Many crypto accounts use 1/n threads for complex stories. Only individual tweets are ingested with no threading concept. Important context from continuations is lost.

### 7. Image/Video Content is Never Analyzed

Screenshots of regulatory filings, charts, and documents are extremely common in crypto Twitter. Images are stored but never OCR'd or analyzed. A tweet saying "BREAKING" with a screenshot of an SEC filing normalizes poorly.

### 8. Potential Double-Counting from Quote RTs

Both an original tweet and its quote-RT may be ingested from different sources. They'll cluster together (good) but engagement metrics may be misleading — the same underlying event counted twice.

---

## Improvement Opportunities

### High Impact

| # | Improvement | Rationale |
|---|---|---|
| 1 | **Embed headline + facts together** | Concatenate before embedding to give richer semantic signal. Two similar headlines with different facts would properly separate. |
| 2 | **Use quoted tweet content in normalization** | Extract `quoted_tweet.text` from `raw` and feed it alongside the quoting tweet. Captures the actual news, not just reactions. |
| 3 | **Periodic centroid recomputation** | Recompute from all member tweet embeddings every N assignments or on a schedule. Prevents drift and improves long-term cluster accuracy. |
| 4 | **Sliding lookback / story persistence** | Let high-signal clusters (high tweet count, high engagement) persist beyond 48h with decaying match priority instead of hard cutoff. |
| 5 | **Soft promo/spam scoring** | Replace binary filter with a score. A cluster with 1 promo term and 10 tweets from reputable sources shouldn't be killed. Let the score reduce `rankScore` rather than exclude entirely. |

### Medium Impact

| # | Improvement | Rationale |
|---|---|---|
| 6 | **Thread detection and stitching** | When ingesting a tweet that's part of a thread (`is_reply` + same author), fetch and concatenate the full thread before normalization. |
| 7 | **Dynamic source discovery** | Track accounts that frequently appear in keyword scan results but aren't in the source list. Surface as suggested additions or auto-add above a threshold. |
| 8 | **Tiered engagement thresholds** | Use multiple keyword scan tiers: low threshold (5-10 faves) for very recent tweets, higher for older content. Catches breaking news earlier. |
| 9 | **Cluster quality scoring for merge direction** | Factor in source diversity, average engagement, headline specificity, and fact substantiveness — not just tweet count and age. |
| 10 | **Image OCR/analysis pipeline** | Add vision model analysis on tweet images between enrichment and normalization to catch the "screenshot of important document" pattern. |

### Operational

| # | Improvement | Rationale |
|---|---|---|
| 11 | **Concurrency limits on normalization & enrichment** | Add backpressure matching what exists for clustering. Prevents burst overload on LLM/scraping providers. |
| 12 | **Normalization versioning** | Store previous normalization results before overwriting. Enables rollback if a backfill degrades quality. |
| 13 | **Fallback to raw text for empty headlines** | If LLM normalization produces an empty headline, fall back to truncated raw `tweet_text` rather than dropping the tweet entirely. |
