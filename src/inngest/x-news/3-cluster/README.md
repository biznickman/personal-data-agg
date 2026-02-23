# X News Cluster Stage

This folder is reserved for story clustering logic.

Planned scope:
- Build normalized-story clustering from `tweets.normalized_headline` + `tweets.normalized_facts`
- Consume `x-news/tweet.normalized` events and emit cluster events for curation/alerting
- Keep clustering decisions separate from ingest/enrichment
