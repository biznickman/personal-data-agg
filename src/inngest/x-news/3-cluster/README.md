# X News Cluster Stage

Clustering is computed **on-the-fly** at query time via the `cluster_tweets_by_embedding`
Postgres function (connected-components, pgvector cosine distance). No persistent cluster
state is written by the pipeline — tweet embeddings are the only artifact stored.

## Functions

- `assign.ts` (`x-news-cluster-assign`, event: `x-news/tweet.normalized`)
  - Loads the tweet's `normalized_headline` (falls back to raw tweet text)
  - Generates a `normalized_headline_embedding` via Gemini if not already present
  - Persists the embedding to `tweets.normalized_headline_embedding`
  - Does **not** assign the tweet to any cluster table

- `backfill.ts` (`x-news-cluster-backfill`, event: `x-news/cluster.backfill.requested`)
  - Finds tweets that are missing `normalized_headline_embedding`
  - Re-queues them via `x-news/tweet.normalized` to trigger embedding generation
  - Supports `allTweets: true` to re-embed everything, `lookbackHours` to limit window

## Helpers

- `embeddings.ts`: Gemini `gemini-embedding-001` client with `CLUSTERING` task type
- `tokenize.ts`: fact parsing, tokenization, Jaccard similarity (used as a pre-filter guard)
- `vector.ts`: parse/stringify pgvector text format, cosine similarity, weighted average

## Env knobs

- `GEMINI_API_KEY` (required)
- `X_NEWS_EMBED_MODEL` (default `gemini-embedding-001`)
- `X_NEWS_EMBED_TASK_TYPE` (default `CLUSTERING`)
- `X_NEWS_EMBED_DIMENSIONS` (default `1536`)
- `X_NEWS_EMBED_CONCURRENCY` (default `5`)
- `X_NEWS_CLUSTER_SIMILARITY_THRESHOLD` (default `0.94`, used at query time by `x-news-stories.ts`)
