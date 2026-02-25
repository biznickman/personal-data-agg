-- Track when the sync last touched a cluster
alter table x_news_clusters add column if not exists last_synced_at timestamptz;
-- Track when LLM review last ran
alter table x_news_clusters add column if not exists reviewed_at timestamptz;
-- Soft-delete: clusters not seen in recent syncs become inactive
alter table x_news_clusters add column if not exists is_active boolean not null default true;

create index if not exists x_news_clusters_active
  on x_news_clusters (is_active, last_seen_at desc)
  where is_active = true and merged_into_cluster_id is null;
