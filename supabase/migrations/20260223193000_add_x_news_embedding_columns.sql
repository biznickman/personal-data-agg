-- Adds embedding columns used for x-news semantic clustering.
-- Safe to run multiple times.

create extension if not exists vector with schema public;

alter table if exists public.tweets
  add column if not exists normalized_headline_embedding vector(1536);

create index if not exists tweets_normalized_headline_embedding_hnsw_idx
  on public.tweets using hnsw (normalized_headline_embedding vector_cosine_ops);

alter table if exists public.x_news_clusters
  add column if not exists centroid_embedding vector(1536);

create index if not exists x_news_clusters_centroid_embedding_hnsw_idx
  on public.x_news_clusters using hnsw (centroid_embedding vector_cosine_ops)
  where merged_into_cluster_id is null;
