-- Clear all persistent cluster data. Clustering is now computed on-the-fly
-- via cluster_tweets_by_embedding. Tweet embeddings (normalized_headline_embedding)
-- are preserved — they are what powers the new clustering.

truncate table x_news_cluster_feedback restart identity;
truncate table x_news_cluster_merges   restart identity;
truncate table x_news_cluster_tweets   restart identity;
truncate table x_news_clusters         restart identity cascade;
