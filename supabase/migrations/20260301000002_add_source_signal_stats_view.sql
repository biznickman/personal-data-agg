create or replace view public.x_news_source_signal_stats as
with tweet_counts as (
  select
    lower(t.username) as username,
    count(*) as total_tweets_30d,
    count(ct.tweet_id) as tweets_in_stories_30d,
    count(distinct ct.cluster_id) as distinct_stories_30d
  from public.tweets t
  left join public.x_news_cluster_tweets ct on ct.tweet_id = t.id
  left join public.x_news_clusters c on c.id = ct.cluster_id
    and c.merged_into_cluster_id is null
    and c.is_story_candidate = true
  where t.created_at >= now() - interval '30 days'
  group by lower(t.username)
)
select
  s.id as source_id,
  s.name,
  s.source_type,
  s.is_active,
  coalesce(tc.total_tweets_30d, 0) as total_tweets_30d,
  coalesce(tc.tweets_in_stories_30d, 0) as tweets_in_stories_30d,
  coalesce(tc.distinct_stories_30d, 0) as distinct_stories_30d,
  case
    when coalesce(tc.total_tweets_30d, 0) = 0 then 0
    else round(100.0 * coalesce(tc.tweets_in_stories_30d, 0) / tc.total_tweets_30d, 1)
  end as signal_pct
from public.x_news_sources s
left join tweet_counts tc on tc.username = s.name
where s.source_type = 'account';
