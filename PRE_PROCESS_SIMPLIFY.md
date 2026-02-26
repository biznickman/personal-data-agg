│ Plan to implement                                                                                                                              │
│                                                                                                                                                │
│ Consolidate Tweet Pre-Processing + Add Image Enrichment                                                                                        │
│                                                                                                                                                │
│ Context                                                                                                                                        │
│                                                                                                                                                │
│ The tweet pre-processing pipeline is currently spread across 4 event-driven Inngest functions chained via events: ingest → enrich-urls →       │
│ normalize → assign-embedding. This makes the flow hard to follow, creates coordination complexity (e.g., "don't normalize until URLs are       │
│ enriched"), and leaves no room for image analysis. Tweets with images but sparse text get normalized as "Link Shared Without Context" because  │
│ images are never analyzed.                                                                                                                     │
│                                                                                                                                                │
│ The fix: consolidate steps 2-4 into a single xNewsTweetPreprocess orchestrator function that handles URL enrichment, image                     │
│ classification/summarization, normalization, and embedding as sequential Inngest steps. Each step is individually retryable and observable in  │
│ the Inngest dashboard.                                                                                                                         │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ Architecture Change                                                                                                                            │
│                                                                                                                                                │
│ Before:                                                                                                                                        │
│ Ingest → emit url.enrich (per URL) → emit tweet.normalize (per tweet w/o URLs)                                                                 │
│          EnrichUrls → emit tweet.normalize                                                                                                     │
│                       Normalize → emit tweet.normalized                                                                                        │
│                                   ClusterAssign (embedding)                                                                                    │
│                                                                                                                                                │
│ After:                                                                                                                                         │
│ Ingest → emit tweet.preprocess (per tweet)                                                                                                     │
│          Preprocess:                                                                                                                           │
│            step: enrich-urls                                                                                                                   │
│            step: classify-image-{id}                                                                                                           │
│            step: summarize-image-{id}                                                                                                          │
│            step: normalize                                                                                                                     │
│            step: embed                                                                                                                         │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ File Changes                                                                                                                                   │
│                                                                                                                                                │
│ New Files                                                                                                                                      │
│                                                                                                                                                │
│ ┌───────────────────────────────────────────────┬──────────────────────────────────────────────────────────┐                                   │
│ │                     File                      │                         Purpose                          │                                   │
│ ├───────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤                                   │
│ │ src/inngest/x-news/services/image-analyzer.ts │ Vision LLM service: classifyImage() and summarizeImage() │                                   │
│ ├───────────────────────────────────────────────┼──────────────────────────────────────────────────────────┤                                   │
│ │ src/inngest/x-news/2-enrich/preprocess.ts     │ The single orchestrator function                         │                                   │
│ └───────────────────────────────────────────────┴──────────────────────────────────────────────────────────┘                                   │
│                                                                                                                                                │
│ Modified Files                                                                                                                                 │
│                                                                                                                                                │
│ ┌─────────────────────────────────────────────────┬─────────────────────────────────────────────────────────────────┐                          │
│ │                      File                       │                             Change                              │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/models/tweet-images.ts       │ Add listByTweetId(), updateAnalysis(), updateSummary()          │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/models/index.ts              │ Export new TweetImageRow type                                   │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/utils/normalize-prompt.ts    │ Add optional imageContexts param to user prompt builder         │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/services/story-normalizer.ts │ Pass through imageContexts to prompt builder                    │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/1-ingest/accounts.ts         │ Emit x-news/tweet.preprocess instead of split events            │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/1-ingest/keywords.ts         │ Same as accounts.ts                                             │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/3-cluster/backfill.ts        │ Emit x-news/tweet.preprocess instead of x-news/tweet.normalized │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/x-news/index.ts                     │ Replace 3 old exports with xNewsTweetPreprocess                 │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/functions.ts                        │ Same replacement                                                │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/app/api/inngest/route.ts                    │ Same replacement                                                │                          │
│ ├─────────────────────────────────────────────────┼─────────────────────────────────────────────────────────────────┤                          │
│ │ src/inngest/run-status.ts                       │ Add "x-news-tweet-preprocess" to union                          │                          │
│ └─────────────────────────────────────────────────┴─────────────────────────────────────────────────────────────────┘                          │
│                                                                                                                                                │
│ Unregistered (files kept for reference)                                                                                                        │
│                                                                                                                                                │
│ - src/inngest/x-news/2-enrich/enrich-urls.ts                                                                                                   │
│ - src/inngest/x-news/2-enrich/normalize.ts                                                                                                     │
│ - src/inngest/x-news/3-cluster/assign.ts                                                                                                       │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ 1. TweetImagesModel Extensions                                                                                                                 │
│                                                                                                                                                │
│ File: src/inngest/x-news/models/tweet-images.ts                                                                                                │
│                                                                                                                                                │
│ Add three methods + export TweetImageRow type:                                                                                                 │
│                                                                                                                                                │
│ - listByTweetId(tweetId: string) → returns all images for a tweet with all columns                                                             │
│ - updateAnalysis(id, { imageCategory, warrantsFinancialAnalysis, initialClaudeAnalysis }) → stores classification                              │
│ - updateSummary(id, { summary, claudeSummaryPayload }) → stores summarization result                                                           │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ 2. Image Analyzer Service                                                                                                                      │
│                                                                                                                                                │
│ File: src/inngest/x-news/services/image-analyzer.ts                                                                                            │
│                                                                                                                                                │
│ Mirrors the callOpenRouter/callPortkey pattern from story-normalizer.ts but uses multimodal messages with image_url content blocks.            │
│                                                                                                                                                │
│ Uses same provider config (X_NEWS_NORMALIZER_PROVIDER / X_NEWS_NORMALIZER_MODEL) — no separate env vars needed.                                │
│                                                                                                                                                │
│ classifyImage(imageUrl: string) → ImageClassification                                                                                          │
│                                                                                                                                                │
│ - Vision call with detail: "low" (fast, cheap)                                                                                                 │
│ - Returns { image_category, warrants_financial_analysis, brief_description, reason }                                                           │
│ - Categories: logo, person, place, news_headline, chart, table, tweet, document, article, other                                                │
│ - Classification prompt from user's prior implementation (adapted for JSON output)                                                             │
│                                                                                                                                                │
│ summarizeImage(imageUrl: string, tweetText: string) → ImageSummary                                                                             │
│                                                                                                                                                │
│ - Vision call with detail: "high" (full resolution for charts/tables)                                                                          │
│ - Returns { summary } — 1-3 sentence integrated summary                                                                                        │
│ - Prompt includes tweet_text for context                                                                                                       │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ 3. Normalization Prompt Update                                                                                                                 │
│                                                                                                                                                │
│ File: src/inngest/x-news/utils/normalize-prompt.ts                                                                                             │
│                                                                                                                                                │
│ Add optional imageContexts?: NormalizationImageContext[] to buildNormalizationUserPrompt. When present, append after </linked_articles>:       │
│                                                                                                                                                │
│ <image_analysis>                                                                                                                               │
│ <image index="1" category="chart">                                                                                                             │
│ Summary of chart content...                                                                                                                    │
│ </image>                                                                                                                                       │
│ </image_analysis>                                                                                                                              │
│                                                                                                                                                │
│ Backward-compatible — if imageContexts is undefined/empty, nothing changes.                                                                    │
│                                                                                                                                                │
│ File: src/inngest/x-news/services/story-normalizer.ts                                                                                          │
│                                                                                                                                                │
│ Add imageContexts to the normalizeStory() params and pass through to prompt builder.                                                           │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ 4. Preprocess Orchestrator Function                                                                                                            │
│                                                                                                                                                │
│ File: src/inngest/x-news/2-enrich/preprocess.ts                                                                                                │
│                                                                                                                                                │
│ xNewsTweetPreprocess                                                                                                                           │
│   id: "x-news-tweet-preprocess"                                                                                                                │
│   event: "x-news/tweet.preprocess"                                                                                                             │
│   concurrency: 5, timeout: 5m, retries: 2                                                                                                      │
│                                                                                                                                                │
│ Step flow:                                                                                                                                     │
│                                                                                                                                                │
│ step "load-tweet"                                                                                                                              │
│ - TweetsModel.findByTweetId(tweetId) + findNormalizedByTweetId(tweetId)                                                                        │
│ - Early return if tweet not found                                                                                                              │
│ - Skip if already has embedding (unless reason === "backfill")                                                                                 │
│                                                                                                                                                │
│ step "enrich-urls"                                                                                                                             │
│ - TweetUrlsModel.listPendingByTweetIds([tweetId])                                                                                              │
│ - For each pending URL: processTweetUrlById(row.id, row.url) with try/catch                                                                    │
│ - Failures logged and marked with error content (matching current behavior)                                                                    │
│ - Single step (tweets have 0-2 URLs typically)                                                                                                 │
│                                                                                                                                                │
│ step "load-images"                                                                                                                             │
│ - TweetImagesModel.listByTweetId(tweetId)                                                                                                      │
│ - Return images where image_category IS NULL                                                                                                   │
│                                                                                                                                                │
│ step classify-image-${image.id} (dynamic, one per unclassified image)                                                                          │
│ - Call classifyImage(image.image_url)                                                                                                          │
│ - Store via TweetImagesModel.updateAnalysis()                                                                                                  │
│ - On failure: store image_category: "error", continue                                                                                          │
│                                                                                                                                                │
│ step summarize-image-${image.id} (dynamic, only where warrants_financial_analysis === true)                                                    │
│ - Call summarizeImage(image.image_url, tweet.tweet_text)                                                                                       │
│ - Store via TweetImagesModel.updateSummary()                                                                                                   │
│ - On failure: log warning, skip (non-fatal)                                                                                                    │
│                                                                                                                                                │
│ step "normalize"                                                                                                                               │
│ - Load fresh URL contexts + image data                                                                                                         │
│ - Build imageContexts from images with summaries                                                                                               │
│ - Key change: allow normalization when tweet has no text BUT has image summaries                                                               │
│ - Call normalizeStory({ ..., imageContexts })                                                                                                  │
│ - Store via TweetsModel.updateNormalization()                                                                                                  │
│                                                                                                                                                │
│ step "embed"                                                                                                                                   │
│ - Load normalized headline, generate embedding via embedTextForClustering()                                                                    │
│ - Store via TweetsModel.updateNormalizedHeadlineEmbedding()                                                                                    │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ 5. Ingest Function Changes                                                                                                                     │
│                                                                                                                                                │
│ Files: accounts.ts, keywords.ts                                                                                                                │
│                                                                                                                                                │
│ Replace the two-phase event emission (url.enrich + tweet.normalize) with a single:                                                             │
│                                                                                                                                                │
│ await step.sendEvent("enqueue-preprocessing",                                                                                                  │
│   tweetIdsToPreprocess.map(tweetId => ({                                                                                                       │
│     name: "x-news/tweet.preprocess",                                                                                                           │
│     data: { tweetId, reason: "ingest" },                                                                                                       │
│   }))                                                                                                                                          │
│ );                                                                                                                                             │
│                                                                                                                                                │
│ Simplification: no longer need to separate tweets by "has pending URLs" vs "ready to normalize" — the preprocess function handles URL          │
│ enrichment internally. Just emit for all unnormalized tweets.                                                                                  │
│                                                                                                                                                │
│ Remove TweetUrlsModel.listPendingByTweetIds call and the pending-URL filtering logic from the ingest step.                                     │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ 6. Backfill Update                                                                                                                             │
│                                                                                                                                                │
│ File: src/inngest/x-news/3-cluster/backfill.ts                                                                                                 │
│                                                                                                                                                │
│ Change emitted event from x-news/tweet.normalized to x-news/tweet.preprocess with reason: "backfill". This makes backfill re-run the full      │
│ pipeline including image analysis.                                                                                                             │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ 7. Registration Wiring                                                                                                                         │
│                                                                                                                                                │
│ - index.ts: Export xNewsTweetPreprocess, remove xNewsEnrichUrls, xNewsNormalize, xNewsClusterAssign                                            │
│ - functions.ts: Same                                                                                                                           │
│ - route.ts: Same                                                                                                                               │
│ - run-status.ts: Add "x-news-tweet-preprocess" to union (keep old IDs for historical records)                                                  │
│                                                                                                                                                │
│ ---                                                                                                                                            │
│ Verification                                                                                                                                   │
│                                                                                                                                                │
│ 1. npx tsc --noEmit — clean compilation                                                                                                        │
│ 2. Run npx inngest-cli dev, trigger x-news-tweet-preprocess manually with a tweet that has images                                              │
│ 3. Check Inngest dashboard: all steps (enrich-urls, classify-image-, summarize-image-, normalize, embed) execute in sequence                   │
│ 4. Query tweet_images — confirm image_category and summary populated                                                                           │
│ 5. Query tweets — confirm normalized_headline reflects image content (not "Link Shared Without Context")                                       │
│ 6. Trigger ingest, confirm it emits x-news/tweet.preprocess events                                                                             │
│ 7. After a sync cycle, verify clusters form correctly from image-enriched tweets                                                               │
│ 8. Run backfill for existing tweets with unanalyzed images  
