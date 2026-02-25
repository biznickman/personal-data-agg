 Known Flaws and Limitations                                                                                                                          │
│                                                                                                                                                      │
│ Structural                                                                                                                                           │
│                                                                                                                                                      │
│ 1. O(N²) RPC timeout risk — cluster_tweets_by_embedding does pairwise cosine comparisons. For 24h windows during high-ingestion periods (1000+       │
│ tweets), the 60s function-level timeout can still be hit. Mitigation: the sync uses 24h window (not 48h); if it times out, the sync step fails and   │
│ Inngest retries. Not a data-loss risk, just a delay.                                                                                                 │
│ 2. Jaccard matching is a heuristic — If a story gets a burst of 30 new tweets in one sync cycle, the Jaccard overlap with the existing persistent    │
│ cluster may fall below the 0.25 threshold (existing cluster has e.g. 5 tweets, only 5/35 overlap). This would create a duplicate persistent cluster  │
│ for the same story. Mitigation: tune MATCH_JACCARD_THRESHOLD lower (0.15) or use absolute intersection count >= 2 as a fallback.                     │
│ 3. Window edge flickering — Tweets at exactly the 24h boundary may appear in one sync but not the next. The "only remove tweets within sync window"  │
│ rule prevents this from silently purging old assignments, but a tweet at the boundary could oscillate in/out of the cluster.                         │
│ 4. Multi-day story fragmentation — A story that starts getting coverage after the 24h sync window has passed may not connect to its original         │
│ persistent cluster. The Jaccard match works when the existing cluster has members still within the window, but a 48h+ story is at risk of splitting  │
│ into "day 1 cluster" and "day 2 cluster." The max_days_window=3 parameter in the RPC somewhat mitigates this.                                        │
│ 5. No merge detection — Two persistent clusters about the same story (created in different time windows) won't be merged automatically. The          │
│ x_news_cluster_merges table exists for this, but merge logic is out of scope for this pass.                                                          │
│                                                                                                                                                      │
│ LLM Review                                                                                                                                           │
│                                                                                                                                                      │
│ 6. LLM review can remove legitimate tweets — The LLM sees text only, not embedding similarity. A tweet with an unusual framing of the main story     │
│ might be incorrectly flagged. Mitigation: conservative prompt ("only flag completely different topics"), and: removed tweets can come back in the    │
│ next sync if the RPC still clusters them together (see flaw #7).                                                                                     │
│ 7. LLM removals are overridden by next sync — If the LLM removes tweet X from cluster 42, but the next sync runs and the RPC still assigns tweet X   │
│ to cluster 42's tweet group, the sync will re-add it. By design: the sync (embedding similarity) is the ground truth. LLM review is a soft,          │
│ ephemeral signal between syncs. No exclusion table needed.                                                                                           │
│ 8. LLM cost at scale — Reviewing every new cluster and every cluster with 5+ new members could get expensive during high-ingestion periods.          │
│ Mitigation: reviewed_at cooldown (don't re-review within 30 min), max 30 tweets shown to LLM, use Claude Haiku (cheapest model).                     │
│ 9. LLM doesn't see cluster history — The LLM review has no knowledge of what the cluster used to look like, or why certain tweets were previously    │
│ removed by user feedback. Future: pass x_news_cluster_feedback context to the LLM.                                                                   │
│                                                                                                                                                      │
│ Feedback                                                                                                                                             │
│                                                                                                                                                      │
│ 10. Feedback still broken for RPC-returned clusters — The stories API returns clusterId from the RPC (an ephemeral row_number()), not a persistent   │
│ cluster ID. The feedback route validates against x_news_clusters.id and will 404. Fixing this properly requires the stories API to return the        │
│ matched persistent cluster ID — either via a join in the sync output, or by querying x_news_cluster_tweets at story-fetch time to map tweet sets →   │
│ persistent cluster IDs. Out of scope for this pass; tracked as follow-up.    
