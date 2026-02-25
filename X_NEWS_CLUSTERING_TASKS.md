# X News Clustering — Active Task List

Generated from a live database review on 2026-02-25, analyzing 500 active clusters from the last 48 hours.

---

## Task 1: Fix Duplicate Cluster Creation
**Status:** Not Started
**Priority:** Critical
**Impact:** High

### Problem
45 headlines have duplicate clusters, many with **13 identical copies**:
- "Bitcoin Price Analysis Suggests Potential Upward Movement" → 13 clusters, 60 tweets
- "JP Morgan Forecasts Gold Price at $6,300" → 13 clusters, 42 tweets
- "Stripe Co-Founder Predicts Rise of AI Agent Commerce" → 13 clusters, 52 tweets

The sync system is creating parallel clusters for the same story instead of matching them to existing ones.

### Evidence
- 500 active clusters but only 164 unique headlines
- The same story fragments into 10+ clusters that never merge

### Desired Outcome
Each distinct story should have exactly one cluster. The sync process should reliably match new tweets to existing clusters before creating new ones.

---

## Task 2: Spam / Bot Detection
**Status:** Not Started
**Priority:** Critical
**Impact:** High

### Problem
The top 3 clusters by tweet count are all spam, drowning out real stories:
- Cluster 48: "Punch Coin Airdrop" — 54 tweets from 2-3 spam accounts posting near-identical promo text
- Cluster 3: "XRP Community Day" — 50 tweets from a single user (@0xKevinRich) repeating the same scam
- Cluster 6: "GWEI Token Airdrop" — 50 tweets from spam accounts

Real stories like Stripe/PayPal (9 tweets, 9 users) and Iran retaliation (7 tweets, 4 users) are ranked below these.

### Evidence
- Cluster 3: 50 tweets, only 2 unique users (one account generating ~48 tweets)
- Cluster 48: 54 tweets, 3 users — all tweets are slight rewrites of the same airdrop promo
- These clusters score highest because the ranking formula weights volume (tweet count) heavily

### Desired Outcome
- Detect and flag clusters where a single user contributes a disproportionate share of tweets
- Penalize clusters with repetitive/near-identical tweet text
- Spam clusters should not appear as top story candidates

---

## Task 3: Improve Cluster Purity (Prevent Unrelated Merges)
**Status:** Not Started
**Priority:** High
**Impact:** High

### Problem
Semantically adjacent but factually distinct stories are being merged into one cluster:
- Cluster 2221 ("Bitcoin CME Gap $81,165") absorbed tweets about: Bitcoin $68K, TD Cowen $225K forecast, Bank of America gold forecast, and a gold vs. SPY chart — four different stories
- Cluster 374 (Dutch crypto tax cancellation) absorbed South Korea crypto influencer disclosure tweets — different countries, different policies

### Evidence
- Cluster 2221: 7 tweets covering at least 4 unrelated topics, similarity scores ranging 0.788–0.956
- Cluster 374: Dutch tax tweets mixed with South Korean regulation tweets (sim 0.968–0.990)
- Financial/market tweets have high semantic overlap in embedding space regardless of actual content

### Desired Outcome
- Tighter assignment/merge thresholds or better embedding differentiation
- Consider embedding headline + facts together (Improvement #1 from analysis doc) to separate stories with similar headlines but different facts
- Clusters should represent a single coherent story

---

## Task 4: Fix "Link Shared Without Context" Catch-All Cluster
**Status:** Not Started
**Priority:** Medium
**Impact:** Medium

### Problem
Cluster 30 has 17 tweets that are all bare URLs with no text body (mostly from @Crypto_Briefing). The LLM normalizes every one to "Link Shared Without Context" and they cluster together despite linking to completely different articles.

### Evidence
- All tweets in cluster 30 are bare URLs: `https://t.co/...` with no surrounding text
- Each URL points to a different article, but normalization produces the identical headline for all of them
- URL enrichment either failed for these tweets or the enriched content wasn't passed to normalization

### Desired Outcome
- Investigate why URL enrichment isn't providing article content for these tweets
- If enrichment succeeds, the normalized headline should reflect the article, not the bare URL
- If enrichment fails, these tweets should not cluster together as if they're the same story
- Consider excluding tweets that normalize to generic fallback headlines from clustering

---

## Task 5: Propagate Facts to Cluster-Level Records
**Status:** Not Started
**Priority:** Medium
**Impact:** Medium

### Problem
257 out of 257 story candidate clusters have **empty facts at the cluster level**, even though individual tweets within those clusters have well-populated `normalized_facts`.

### Evidence
- Every cluster's `normalized_facts` field in `x_news_clusters` is empty `[]`
- Individual tweet records have rich facts (e.g., "Iran loaded nearly 20 million barrels of oil between Feb 15-20")
- The stories API works around this by picking facts from the headline tweet, but the cluster record itself is incomplete

### Desired Outcome
- Cluster sync should populate `normalized_facts` on the cluster record from the best/representative tweet
- Facts should be available directly on the cluster for downstream consumers

---

## Task 6: Image OCR / Analysis Pipeline
**Status:** Not Started
**Priority:** Medium
**Impact:** Medium

### Problem
Image content in tweets is never analyzed. Screenshots of regulatory filings, charts, price data, and documents are common in crypto Twitter but are invisible to the normalization and clustering pipeline.

### Evidence
- 0 images found linked to tweets in the top 30 clusters (the `tweet_images` table may not be populating correctly, or images aren't linked to the right tweet IDs)
- The analysis doc (Improvement #10) identified this as a medium-impact opportunity
- Before implementing OCR, need to verify the image storage pipeline is working

### Desired Outcome
- First: verify `tweet_images` table is being populated correctly
- Add a vision model analysis step between enrichment and normalization
- Image content (OCR text, chart descriptions, document summaries) feeds into the normalization prompt
- Tweets with "BREAKING" + screenshot of an SEC filing should normalize to the filing content, not just "BREAKING"

---

## Completed

_(None yet)_
