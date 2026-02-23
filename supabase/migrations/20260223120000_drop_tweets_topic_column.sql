-- Removes legacy ingest-tag column from tweets.
-- Safe to run multiple times.
alter table if exists public.tweets
  drop column if exists topic;
