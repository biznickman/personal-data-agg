-- Track when the curation LLM last evaluated this cluster
alter table x_news_clusters add column if not exists curated_at timestamptz;
