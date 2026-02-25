-- Set statement_timeout as a function-level attribute (the correct approach).
-- This overrides the role-level default (anon=3s, authenticated=8s) for this
-- specific function call, allowing the pairwise cosine query to run up to 60s.

create or replace function cluster_tweets_by_embedding(
  since_timestamp      timestamptz,
  similarity_threshold float     default 0.78,
  min_cluster_size     int       default 2,
  max_days_window      int       default 3
)
returns table (
  cluster_id    bigint,
  tweet_ids     text[],
  earliest_date timestamptz,
  latest_date   timestamptz,
  tweet_count   bigint
)
language plpgsql
set statement_timeout TO '60s'
as $$
begin
  return query
  with recursive candidate_tweets as (
    select
      t.id,
      t.tweet_id,
      t.normalized_headline_embedding as embedding,
      t.tweet_time
    from tweets t
    where t.tweet_time >= since_timestamp
      and t.normalized_headline_embedding is not null
      and t.normalized_headline is not null
      and t.is_latest_version = true
      and t.is_retweet = false
      and t.is_reply   = false
      and t.is_quote   = false
  ),

  similarity_pairs as (
    select t1.id as id1, t2.id as id2
    from candidate_tweets t1
    join candidate_tweets t2 on t1.id < t2.id
    where 1 - (t1.embedding <=> t2.embedding) >= similarity_threshold
  ),

  edges as (
    select id1 as node, id2 as neighbor from similarity_pairs
    union all
    select id2 as node, id1 as neighbor from similarity_pairs
  ),

  connected_components as (
    select node, node as root
    from (select distinct node from edges) all_nodes

    union

    select e.node, least(cc.root, e.neighbor) as root
    from connected_components cc
    join edges e on cc.node = e.node
    where cc.root > e.neighbor
  ),

  final_assignment as (
    select node, min(root) as root
    from connected_components
    group by node
  ),

  clusters_raw as (
    select
      fa.root                                           as cluster_root,
      array_agg(ct.tweet_id order by ct.id)            as tweet_ids_arr,
      min(ct.tweet_time)                                as t_earliest,
      max(ct.tweet_time)                                as t_latest,
      count(*)::bigint                                  as cnt
    from final_assignment fa
    join candidate_tweets ct on ct.id = fa.node
    group by fa.root
  )

  select
    row_number() over (order by cr.t_earliest, cr.cluster_root)::bigint as cluster_id,
    cr.tweet_ids_arr   as tweet_ids,
    cr.t_earliest      as earliest_date,
    cr.t_latest        as latest_date,
    cr.cnt             as tweet_count
  from clusters_raw cr
  where cr.cnt >= min_cluster_size
    and cr.t_latest <= cr.t_earliest + (max_days_window || ' days')::interval
  order by cr.t_earliest;
end;
$$;
