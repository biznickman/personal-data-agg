-- Track when a cluster first became a story candidate (>=3 tweets, >=2 users)
alter table x_news_clusters add column if not exists promoted_at timestamptz;
