-- Computes tweet clusters on-the-fly using embedding cosine similarity.
--
-- Uses a recursive connected-components approach: two tweets become part of
-- the same cluster if their normalized_headline_embedding cosine similarity
-- meets the threshold. Transitively connected tweets form one cluster.
--
-- Parameters:
--   since_timestamp      Start of the time window to cluster
--   similarity_threshold Cosine similarity required to link two tweets (default 0.78)
--   min_cluster_size     Minimum tweets for a cluster to be returned (default 2)
--   max_days_window      Max days between first and last tweet in a cluster (default 3)
--
-- Returns one row per cluster:
--   cluster_id    Sequential number ordered by earliest_date
--   tweet_ids     Array of tweet_id strings (Twitter IDs) in the cluster
--   earliest_date Timestamp of the oldest tweet in the cluster
--   latest_date   Timestamp of the newest tweet in the cluster
--   tweet_count   Number of tweets in the cluster

create or replace function cluster_tweets_by_embedding(
  since_timestamp      timestamptz,
  similarity_threshold float     default 0.78,
  min_cluster_size     int       default 2,
  max_days_window      int       default 3
)
returns table (
  cluster_id   bigint,
  tweet_ids    text[],
  earliest_date timestamptz,
  latest_date   timestamptz,
  tweet_count   bigint
)
language plpgsql
as $$
begin
  return query
  with recursive candidate_tweets as (
    -- Tweets in the window that have been normalized and embedded
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
      and t.is_reply  = false
      and t.is_quote  = false
  ),

  similarity_pairs as (
    -- All tweet pairs that meet the similarity threshold.
    -- Uses the HNSW index via <=> (cosine distance = 1 - cosine similarity).
    select
      t1.id as id1,
      t2.id as id2
    from candidate_tweets t1
    join candidate_tweets t2 on t1.id < t2.id
    where 1 - (t1.embedding <=> t2.embedding) >= similarity_threshold
  ),

  edges as (
    -- Undirected edge list for the graph
    select id1 as node, id2 as neighbor from similarity_pairs
    union all
    select id2 as node, id1 as neighbor from similarity_pairs
  ),

  connected_components as (
    -- Recursive label-propagation: each node inherits the smallest ID
    -- it can reach, which becomes the cluster root.
    select node, node as root
    from (select distinct node from edges) all_nodes

    union

    select e.node, least(cc.root, e.neighbor) as root
    from connected_components cc
    join edges e on cc.node = e.node
    where cc.root > e.neighbor
  ),

  final_assignment as (
    -- Keep only the minimum root per node (converged label)
    select distinct on (node)
      node,
      root
    from connected_components
    order by node, root
  ),

  clusters_with_metadata as (
    select
      fa.root,
      array_agg(ct.tweet_id order by ct.id) as tweet_ids_arr,
      min(ct.tweet_time) as earliest_date,
      max(ct.tweet_time) as latest_date,
      count(*)           as cnt
    from final_assignment fa
    join candidate_tweets ct on ct.id = fa.node
    group by fa.root
  ),

  valid_clusters as (
    -- Apply minimum size and time-spread filters
    select *
    from clusters_with_metadata
    where cnt >= min_cluster_size
      and latest_date <= earliest_date + (max_days_window || ' days')::interval
  )

  select
    row_number() over (order by earliest_date, root)::bigint as cluster_id,
    tweet_ids_arr  as tweet_ids,
    earliest_date,
    latest_date,
    cnt            as tweet_count
  from valid_clusters
  order by earliest_date;
end;
$$;
