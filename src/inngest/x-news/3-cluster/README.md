# X News Cluster Stage

This folder implements lightweight clustering for normalized tweet stories.

## Functions

- `assign.ts` (`x-news-cluster-assign`, event: `x-news/tweet.normalized`)
  - Reads `tweets.normalized_headline` + `tweets.normalized_facts`
  - Lazily writes `tweets.normalized_headline_embedding` via Gemini if not already present
  - Builds canonical text + token set
  - Attaches tweet to best recent cluster (embedding cosine similarity with Jaccard pre-filter) or creates a new cluster
  - Recomputes cluster stats and `is_story_candidate`
  - Emits `x-news/cluster.created` or `x-news/cluster.updated`

- `merge.ts` (`x-news-cluster-merge`, cron: every 2 minutes)
  - Scans recent active clusters
  - Merges highly similar clusters using embedding cosine similarity (with Jaccard pre-filter)
  - Writes merge history and emits `x-news/cluster.updated`

- `backfill.ts` (`x-news-cluster-backfill`, event: `x-news/cluster.backfill.requested`)
  - Loads historical normalized tweets
  - Optionally skips already-assigned tweets
  - Supports `rebuild` mode to clear existing clusters and replay all normalized tweets
  - Emits `x-news/tweet.normalized` to backfill cluster assignment
  - Recomputes active cluster stats so new gating logic applies immediately

## Helpers

- `tokenize.ts`: fact parsing, canonical text, tokenization, Jaccard similarity
- `cluster-db.ts`: story-candidate threshold evaluation + promo/spam + low-information gating + stats recompute

## Env knobs

- `X_NEWS_CLUSTER_ASSIGN_THRESHOLD_EMBEDDING` (default `0.76`)
- `X_NEWS_CLUSTER_ASSIGN_MIN_LEXICAL_OVERLAP_EMBEDDING` (default `0.08`)
- `X_NEWS_CLUSTER_MERGE_THRESHOLD_EMBEDDING` (default `0.82`)
- `X_NEWS_CLUSTER_MERGE_MIN_LEXICAL_OVERLAP_EMBEDDING` (default `0.08`)
- `X_NEWS_CLUSTER_LOOKBACK_HOURS` (default `48`)
- `X_NEWS_CLUSTER_MAX_CANDIDATES` (default `200`)
- `X_NEWS_CLUSTER_MIN_TWEETS` (default `3`)
- `X_NEWS_CLUSTER_MIN_USERS` (default `2`)
- `GEMINI_API_KEY` (required)
- `X_NEWS_EMBED_MODEL` (default `gemini-embedding-001`)
- `X_NEWS_EMBED_TASK_TYPE` (default `CLUSTERING`)
- `X_NEWS_EMBED_DIMENSIONS` (default `1536`)
