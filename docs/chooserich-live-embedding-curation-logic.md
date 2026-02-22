# Chooserich Live: Embedding And Curation Logic

This document captures how the original `chooserich-live` story pipeline handles embedding, clustering, curation, and manual overrides.

## Scope

Reviewed code paths:

- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/2-enrich/0-preFormatTweet.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/2-enrich/4-extractNews.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/operations/extractTweets/extractNews.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/prompts/tweet_news_extractor/index.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/0-embed.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/operations/embedTweet.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model1/0-cluster-router.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model1/1-create-new-cluster.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model1/2-recalculate-centroids.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model2/0-rollingCluster.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/operations/clusters/model2/fetchClusters.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/createClusterSummary.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/mergeDuplicateClusters.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/4-write/0-writeStory.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/4-write/1-embedStory.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/5-curateStories/0-curateStory.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/6-publish/0-publishStory.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/app/api/clusters/approve/route.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/models/cluster.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/models/tweet.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/supabase/migrations/20250629161357_remote_schema.sql`
- `/Users/nicholasoneill/Dev/chooserich-live/docs/20250813_DuplicateClustersFunctions.sql`

## High-Level Event Flow (Embedding To Publish)

1. `aggregator/tweet.created` -> `preFormatTweet`.
2. `preFormatTweet` preprocesses media/URLs, runs extraction, emits one of:
- `aggregator/tweet-formatted/price-action`
- `aggregator/tweet-formatted/news`
- `aggregator/tweet-formatted/non-news`
3. `aggregator/tweet-formatted/news` -> `embedNews` -> `aggregator/tweet.news-embedded`.
4. Clustering:
- Model 1: `aggregator/tweet.news-embedded` -> router attach/create -> `aggregator/cluster.created|updated`
- Model 2: cron/event -> rolling clustering RPC -> `aggregator/cluster.created|updated`
5. `aggregator/cluster.created|updated` -> `createClusterSummary`.
6. `aggregator/cluster.summarized` (or manual `aggregator/cluster.approved`) -> `writeStory`.
7. `aggregator/story.updated` -> `embedStory` and `curateStory` in parallel.
8. If curated -> `aggregator/story.curated` -> `publishStory` -> `aggregator/story-published`.

## Embedding Logic

### 1) Pre-embedding content qualification

Source: `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/2-enrich/0-preFormatTweet.ts`

Rules:

- If `tweet_id` is null, abort.
- If `tweet.extracted_news` already exists, skip full processing (dedupe guard).
- Always process associated images and URLs first.
- Replies and quote tweets are hard-gated:
- media/URL preprocessing is allowed
- news extraction is skipped
- no `tweet-formatted/news` event emitted
- Only non-reply, non-quote tweets run extraction and downstream news classification.

### 2) News extraction and classification

Sources:

- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/2-enrich/4-extractNews.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/operations/extractTweets/extractNews.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/prompts/tweet_news_extractor/index.ts`

Rules:

- Prompt explicitly instructs model to classify as:
- `CONTAINS_NEWS` or `NO_NEWS`
- `PRICE_ACTION` vs `GENERAL_NEWS`
- Includes explicit "not news" guidance for ads/promotions/referrals.
- Extraction output is saved to `tweets.extracted_news`.
- `containsNews` return condition is strict:
- `classification === "CONTAINS_NEWS"`
- and `result.embedding === null`
- This acts like a gate to avoid re-sending already-embedded tweets through the news-embedding branch.

### 3) Tweet embedding (news items)

Sources:

- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/0-embed.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/operations/embedTweet.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/services/google.ts`

Rules:

- Trigger: `aggregator/tweet-formatted/news`.
- `embedTweet` skips if:
- `tweet.embeddableNews == null`
- both `tweet.embedding` and `tweet.headline_embedding` already exist
- Embedding model:
- Google Gemini embedding (`gemini-embedding-exp-03-07`)
- `taskType: "CLUSTERING"`
- dimension `1536`
- Two vectors are generated:
- `embedding` from full extracted-news text (`headline_fact + extracted_facts`)
- `headline_embedding` from only `headline_fact`
- On completion, emits `aggregator/tweet.news-embedded`.

### 4) Cluster summary embedding

Source: `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/createClusterSummary.ts`

Rules:

- Trigger: `aggregator/cluster.created` and `aggregator/cluster.updated`.
- LLM summary creation runs only at thresholds:
- initial: `tweet_count >= 2`
- updates: at thresholds `[4, 8, 12]`
- Uses up to 20 recent cluster tweets.
- Generates three embeddings from summary text:
- `title_embedding`
- `body_embedding`
- `title_body_embedding`
- Saves summary history record (`cluster_summary_history`) before updating cluster.

### 5) Story embedding

Source: `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/4-write/1-embedStory.ts`

Rules:

- Trigger: `aggregator/story.updated`.
- Skip if story missing.
- Skip if all three story embedding columns already set.
- Generate missing embeddings only (partial regeneration supported):
- `stories.title_embedding`
- `stories.body_embedding`
- `stories.title_body_embedding`
- Persist only embedding columns, not full story row.

## Clustering Logic (What Embeddings Feed)

### Model 1: incremental attach-or-create

Sources:

- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model1/0-cluster-router.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model1/1-create-new-cluster.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model1/2-recalculate-centroids.ts`

Rules:

- Trigger: `aggregator/tweet.news-embedded`.
- Skip replies and retweets.
- Manual-assignment preservation:
- `Tweet.isManuallyAssigned(tweetId, modelId=1)` short-circuits auto-clustering.
- Uses `headline_embedding` only.
- Similarity lookup:
- RPC `find_similar_clusters`
- threshold `0.9`
- lookback `24h`
- if match: assign tweet, emit `aggregator/cluster.updated`
- if no match: emit `clustering/potential-new-cluster-found`
- New-cluster creation is serialized (`concurrency: 1`) to prevent duplicate cluster races.
- Serialized create path performs a second similarity check before insert.
- Hot-cluster centroid refresh runs every 2 minutes in production via `recalculate_cluster_centroid`.

### Model 2: rolling batch clustering

Sources:

- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/model2/0-rollingCluster.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/operations/clusters/model2/fetchClusters.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/supabase/migrations/20250629161357_remote_schema.sql` (`cluster_tweet_headlines`)

Rules:

- Cron every 2 minutes (disabled in dev unless flag enabled).
- Calls `cluster_tweet_headlines` RPC with:
- `similarity_threshold = 0.95`
- `since_timestamp = now - 24h`
- `max_days_window = 1`
- `min_cluster_size = 4`
- SQL function filters:
- excludes retweets/quotes/replies
- requires `is_latest_version = true`
- includes unassigned tweets or tweets tied to recently-started stories
- builds connected components from pairwise embedding similarity
- rejects clusters spanning beyond `max_days_window`
- Persist step calls RPC `persist_and_get_cluster_for_tweets`, then emits `cluster.created|updated`.

### Duplicate-cluster merge before story writing

Sources:

- `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/3-cluster/mergeDuplicateClusters.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/docs/20250813_DuplicateClustersFunctions.sql`

Rules:

- `writeStory` invokes merge check before generating/updating story.
- If current cluster already merged, short-circuits.
- Finds duplicates via RPC `find_cluster_duplicates` with `p_max_distance=0.1`.
- Chooses oldest cluster as merge target.
- If current is oldest, no merge is applied to others (explicit TODO in code).
- If merged, `writeStory` emits `aggregator/cluster.updated` for target and exits.

SQL design (from docs SQL):

- Merge done in one transaction with advisory lock.
- Moves active `cluster_tweets` assignments.
- Updates cluster counts and `merged_into_cluster_id`.
- Re-points tweet `story_id` and handles conflicting stories.
- Writes full audit trail in `merged_cluster_history`.
- Includes rollback path `unmerge_cluster`.

## Curation Logic

### Manual approval/rejection path

Sources:

- `/Users/nicholasoneill/Dev/chooserich-live/src/app/api/clusters/approve/route.ts`
- `/Users/nicholasoneill/Dev/chooserich-live/supabase/migrations/20250629161357_remote_schema.sql` (`set_cluster_approval`)

Rules:

- API requires authenticated Clerk user with `publicMetadata.editor === true`.
- Uses RPC `set_cluster_approval_server` to write:
- `clusters.approved` boolean
- `curated_by`, `curated_at`, `updated_at`
- Emits:
- `aggregator/cluster.approved` when approved=true
- `aggregator/cluster.rejected` when approved=false

### Story write gating (pre-curation)

Source: `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/4-write/0-writeStory.ts`

Rules:

- Triggered by `aggregator/cluster.summarized` and `aggregator/cluster.approved`.
- Hard stops:
- missing cluster
- fewer than 2 tweets
- model 1 cluster not manually approved (`approved !== true`)
- Uses summary-based writing when `summary_title` and `summary_body` exist.
- Falls back to tweet-based writing otherwise.
- Tweet-based updates occur only at tweet counts `[2,4,6,10,15,20]`.

### Story curation filters (auto publish qualification)

Source: `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/5-curateStories/0-curateStory.ts`

Evaluation order:

1. If story already published: skip.
2. If cluster missing: reject.
3. If `cluster.approved === false`: reject immediately (manual reject wins).
4. If `cluster.approved === true`: accept immediately (manual approve wins).
5. If cluster is model 1:
- normally reject auto-publish
- exception: accept if one or more model 2 clusters were merged into it.
6. Require cluster content:
- `tweet_count` exists and tweets list non-empty
- minimum `tweet_count >= 3`
- minimum `user_count >= 2`
7. User-source quality filters:
- remove usernames matching `/business|zerohedge/i`
- require at least 2 unique remaining usernames
8. Spam guard:
- reject if any one username contributes more than 50% of cluster tweets
9. Topic guardrails:
- reject if any topic starts with `/Politics`
- reject if any topic starts with `/Law`
10. If all checks pass:
- emit `aggregator/story.curated`.

### Publish step

Source: `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/newsAggregator/6-publish/0-publishStory.ts`

Rules:

- Trigger: `aggregator/story.curated`.
- Idempotent publish: if `publish_at` already set, no republish.
- Ensures category exists (runs categorization if missing).
- Emits `aggregator/story-published` for downstream push flow.

## Important Edge Cases And Filters Already Implemented

- Duplicate ingest guard at preformat stage (`extracted_news` present -> skip).
- Replies/quotes can still get media/url enrichment but are excluded from news extraction path.
- Model 1 clustering preserves manual tweet-cluster assignment.
- Model 1 story generation requires explicit human approval.
- Model 1 auto-publish exception exists if model 2 clusters merged in.
- Story generation avoids over-updating by fixed update-threshold counts.
- Auto curation explicitly excludes Bloomberg/Zerohedge from source-diversity count.
- Auto curation blocks clusters dominated by one source (>50% share).
- Auto curation blocks political/legal-topic clusters.
- Duplicate cluster merge path exists before writing to reduce duplicate stories.
- Merge logic tracks full audit metadata and supports unmerge rollback (docs SQL).

## Notable Implementation Caveats

- In repo state, most news-aggregator exports are commented out in `/Users/nicholasoneill/Dev/chooserich-live/src/inngest/functions/index.ts`; check runtime deployment config before assuming all steps are active.
- Local migration file does not include all RPC definitions used by code (`persist_and_get_cluster_for_tweets`, `find_cluster_duplicates`, `set_cluster_approval_server`); generated types show these exist in remote schema.
- `find_similar_clusters` in local migration does not include `cluster_model_id`, but code and generated types pass it; this indicates schema drift between local migration snapshot and live DB.
- `createClusterSummary` threshold check uses `Array.find` over ascending thresholds, so for tweet counts above 2 it still resolves to 2 first; this affects intended update-threshold behavior.

## Practical Takeaway

The original system did not rely on one broad relevance score. It used layered gates:

- extraction-level eligibility
- clustering constraints
- write-time constraints
- explicit curation filters
- manual approve/reject override

That layered gating is the main reason it suppresses noise better than naive grouping.

