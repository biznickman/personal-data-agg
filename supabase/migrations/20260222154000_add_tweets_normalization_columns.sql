-- Adds fields for LLM-normalized story extraction.
-- Safe to run multiple times.
alter table if exists public.tweets
  add column if not exists normalized_headline text,
  add column if not exists normalized_facts jsonb;

