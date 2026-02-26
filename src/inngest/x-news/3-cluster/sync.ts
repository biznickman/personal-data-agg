import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { isBlockedAccount } from "@/lib/x-news-accounts";
import { recordFunctionRun } from "../../run-status";

const SYNC_LOOKBACK_HOURS = parseEnvFloat("X_NEWS_SYNC_LOOKBACK_HOURS", 24);
const SIMILARITY_THRESHOLD = parseEnvFloat("X_NEWS_CLUSTER_SIMILARITY_THRESHOLD", 0.94);
const MATCH_JACCARD_THRESHOLD = 0.25;
const MIN_INTERSECTION = 2;
const MIN_CLUSTER_SIZE = 2;
const MAX_DAYS_WINDOW = 3;
const STORY_MIN_TWEETS = 3;
const STORY_MIN_USERS = 2;
const REVIEW_MIN_NEW_MEMBERS = 5;
const STALE_DEACTIVATE_HOURS = 2;
const DB_CHUNK = 200;
const CLUSTER_CHUNK = 50;

function parseEnvFloat(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

type ClusterRpcRow = {
  cluster_id: number;
  tweet_ids: string[];
  tweet_count: number;
  earliest_date: string | null;
  latest_date: string | null;
};

type TweetMetaRow = {
  id: number;
  tweet_id: string;
  username: string | null;
  normalized_headline: string | null;
  tweet_time: string | null;
  likes: number | null;
  retweets: number | null;
  quotes: number | null;
};

type ClusterAction =
  | {
      type: "update";
      persistentClusterId: number;
      rpcTweetIds: string[];
      toAdd: string[];
      toRemove: string[];
    }
  | {
      type: "create";
      tweetIds: string[];
      earliestDate: string | null;
      latestDate: string | null;
    };

function pickHeadlineTweet(tweets: TweetMetaRow[]): TweetMetaRow | null {
  const withHeadline = tweets.filter((t) => t.normalized_headline?.trim());
  const pool = withHeadline.length > 0 ? withHeadline : tweets;
  if (pool.length === 0) return null;
  return pool.reduce((best, t) => {
    const bs = (best.likes ?? 0) + (best.retweets ?? 0) * 2 + (best.quotes ?? 0);
    const ts = (t.likes ?? 0) + (t.retweets ?? 0) * 2 + (t.quotes ?? 0);
    return ts > bs ? t : best;
  });
}

async function loadTweetMeta(dbIds: number[]): Promise<TweetMetaRow[]> {
  if (dbIds.length === 0) return [];
  const rows: TweetMetaRow[] = [];
  for (let i = 0; i < dbIds.length; i += DB_CHUNK) {
    const chunk = dbIds.slice(i, i + DB_CHUNK);
    const { data, error } = await supabase
      .from("tweets")
      .select("id,tweet_id,username,normalized_headline,tweet_time,likes,retweets,quotes")
      .in("id", chunk);
    if (error) throw new Error(`Tweet meta load failed: ${error.message}`);
    rows.push(...((data ?? []) as TweetMetaRow[]));
  }
  return rows;
}

export async function recomputeClusterStats(
  clusterId: number,
  now: string
): Promise<void> {
  const { data: memberRows, error: memberError } = await supabase
    .from("x_news_cluster_tweets")
    .select("tweet_id")
    .eq("cluster_id", clusterId);
  if (memberError) throw new Error(`Load members failed: ${memberError.message}`);

  const dbIds = (memberRows ?? []).map((r) => r.tweet_id as number);
  const tweets = (await loadTweetMeta(dbIds)).filter(
    (t) => !isBlockedAccount(t.username)
  );

  const uniqueUsers = new Set(
    tweets.map((t) => (t.username ?? `id:${t.tweet_id}`).toLowerCase())
  ).size;
  const isStoryCandidate = tweets.length >= STORY_MIN_TWEETS && uniqueUsers >= STORY_MIN_USERS;
  const headlineTweet = pickHeadlineTweet(tweets);

  const latestTs = tweets.reduce((best, t) => {
    const ts = t.tweet_time ? new Date(t.tweet_time).getTime() : 0;
    return ts > best ? ts : best;
  }, 0);
  const lastSeenAt = latestTs > 0 ? new Date(latestTs).toISOString() : now;

  // Deactivate clusters where no non-blocked tweets remain
  const isActive = tweets.length > 0;

  const { error: updateError } = await supabase
    .from("x_news_clusters")
    .update({
      tweet_count: tweets.length,
      unique_user_count: uniqueUsers,
      is_story_candidate: isStoryCandidate,
      normalized_headline: headlineTweet?.normalized_headline ?? null,
      last_seen_at: lastSeenAt,
      last_synced_at: now,
      is_active: isActive,
    })
    .eq("id", clusterId);
  if (updateError) throw new Error(`Cluster stats update failed: ${updateError.message}`);
}

export const xNewsClusterSync = inngest.createFunction(
  {
    id: "x-news-cluster-sync",
    retries: 1,
    concurrency: 1,
    timeouts: {
      finish: "5m",
    },
  },
  { cron: "*/10 * * * *" },
  async ({ step }) => {
    try {
      const since = new Date(
        Date.now() - SYNC_LOOKBACK_HOURS * 60 * 60 * 1000
      ).toISOString();

      // ── Step 1: Run on-the-fly RPC clustering ──────────────────────────────
      const rpcClusters = await step.run("run-rpc-clustering", async () => {
        const { data, error } = await supabase.rpc("cluster_tweets_by_embedding", {
          since_timestamp: since,
          similarity_threshold: SIMILARITY_THRESHOLD,
          min_cluster_size: MIN_CLUSTER_SIZE,
          max_days_window: MAX_DAYS_WINDOW,
        });
        if (error) throw new Error(`RPC clustering failed: ${error.message}`);
        return (data ?? []) as ClusterRpcRow[];
      });

      if (rpcClusters.length === 0) {
        const summary = { status: "ok", rpc_clusters: 0, created: 0, updated: 0 };
        await step.run("record-empty-run", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-sync",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      const allRpcTweetIds = [...new Set(rpcClusters.flatMap((c) => c.tweet_ids))];

      // ── Step 2: Load DB IDs + existing cluster assignments ─────────────────
      const assignments = await step.run("load-existing-assignments", async () => {
        // 2a. Map string tweet IDs → DB ids
        const dbIdMap: Record<string, number> = {};
        for (let i = 0; i < allRpcTweetIds.length; i += DB_CHUNK) {
          const chunk = allRpcTweetIds.slice(i, i + DB_CHUNK);
          const { data, error } = await supabase
            .from("tweets")
            .select("id,tweet_id")
            .in("tweet_id", chunk);
          if (error) throw new Error(`Tweet ID lookup failed: ${error.message}`);
          for (const row of (data ?? []) as Array<{ id: number; tweet_id: string }>) {
            dbIdMap[row.tweet_id] = row.id;
          }
        }

        const dbIds = Object.values(dbIdMap);

        // 2b. Find which persistent cluster each tweet belongs to
        const tweetStringIdToCluster: Record<string, number> = {};
        if (dbIds.length > 0) {
          const dbIdToStrId = Object.fromEntries(
            Object.entries(dbIdMap).map(([str, db]) => [db, str])
          ) as Record<number, string>;

          for (let i = 0; i < dbIds.length; i += DB_CHUNK) {
            const chunk = dbIds.slice(i, i + DB_CHUNK);
            const { data, error } = await supabase
              .from("x_news_cluster_tweets")
              .select("tweet_id,cluster_id")
              .in("tweet_id", chunk);
            if (error) throw new Error(`Load assignments failed: ${error.message}`);
            for (const row of (data ?? []) as Array<{
              tweet_id: number;
              cluster_id: number;
            }>) {
              const strId = dbIdToStrId[row.tweet_id];
              if (strId) tweetStringIdToCluster[strId] = row.cluster_id;
            }
          }
        }

        // 2c. Load window-scoped membership for overlapping persistent clusters
        const involvedClusterIds = [...new Set(Object.values(tweetStringIdToCluster))];
        const clusterWindowTweets: Record<number, string[]> = {};

        if (involvedClusterIds.length > 0) {
          for (let i = 0; i < involvedClusterIds.length; i += CLUSTER_CHUNK) {
            const clusterChunk = involvedClusterIds.slice(i, i + CLUSTER_CHUNK);

            const { data: memberRows, error: memberError } = await supabase
              .from("x_news_cluster_tweets")
              .select("tweet_id,cluster_id")
              .in("cluster_id", clusterChunk);
            if (memberError) throw new Error(`Load cluster members failed: ${memberError.message}`);

            const memberDbIds = (memberRows ?? []).map(
              (r: { tweet_id: number }) => r.tweet_id
            );

            if (memberDbIds.length > 0) {
              const { data: tweetRows, error: tweetError } = await supabase
                .from("tweets")
                .select("id,tweet_id,tweet_time")
                .in("id", memberDbIds);
              if (tweetError) throw new Error(`Load tweet times failed: ${tweetError.message}`);

              const dbIdToCluster: Record<number, number> = {};
              for (const row of (memberRows ?? []) as Array<{
                tweet_id: number;
                cluster_id: number;
              }>) {
                dbIdToCluster[row.tweet_id] = row.cluster_id;
              }

              for (const tweet of (tweetRows ?? []) as Array<{
                id: number;
                tweet_id: string;
              }>) {
                const clusterId = dbIdToCluster[tweet.id];
                if (clusterId === undefined) continue;
                if (!clusterWindowTweets[clusterId]) clusterWindowTweets[clusterId] = [];
                clusterWindowTweets[clusterId].push(tweet.tweet_id);
              }
            }
          }
        }

        return { dbIdMap, tweetStringIdToCluster, clusterWindowTweets };
      });

      // ── Step 3: Match RPC clusters → persistent clusters ───────────────────
      const actions = await step.run("compute-cluster-actions", async () => {
        const { tweetStringIdToCluster, clusterWindowTweets } = assignments;
        const result: ClusterAction[] = [];

        for (const rpcCluster of rpcClusters) {
          const tweetIds = rpcCluster.tweet_ids;
          const rpcSet = new Set(tweetIds);

          // Count overlap votes per persistent cluster
          const clusterVotes: Record<number, number> = {};
          for (const tweetId of tweetIds) {
            const clusterId = tweetStringIdToCluster[tweetId];
            if (clusterId !== undefined) {
              clusterVotes[clusterId] = (clusterVotes[clusterId] ?? 0) + 1;
            }
          }

          const candidateIds = Object.keys(clusterVotes).map(Number);
          if (candidateIds.length === 0) {
            result.push({
              type: "create",
              tweetIds,
              earliestDate: rpcCluster.earliest_date,
              latestDate: rpcCluster.latest_date,
            });
            continue;
          }

          // Plurality cluster
          const bestClusterId = candidateIds.reduce((best, id) =>
            (clusterVotes[id] ?? 0) > (clusterVotes[best] ?? 0) ? id : best
          );

          // Jaccard on window-scoped persistent membership
          const persistentWindowSet = new Set(clusterWindowTweets[bestClusterId] ?? []);
          const intersection = tweetIds.filter((id) => persistentWindowSet.has(id)).length;
          const union = rpcSet.size + persistentWindowSet.size - intersection;
          const jaccard = union > 0 ? intersection / union : 0;

          if (jaccard >= MATCH_JACCARD_THRESHOLD && intersection >= MIN_INTERSECTION) {
            const toAdd = tweetIds.filter(
              (id) =>
                !persistentWindowSet.has(id) &&
                tweetStringIdToCluster[id] === undefined
            );
            const toRemove = [...persistentWindowSet].filter((id) => !rpcSet.has(id));

            result.push({
              type: "update",
              persistentClusterId: bestClusterId,
              rpcTweetIds: tweetIds,
              toAdd,
              toRemove,
            });
          } else {
            result.push({
              type: "create",
              tweetIds,
              earliestDate: rpcCluster.earliest_date,
              latestDate: rpcCluster.latest_date,
            });
          }
        }

        return result;
      });

      // ── Step 4: Execute updates and creates ────────────────────────────────
      const { newClusterIds, updatedClusterIds } = await step.run(
        "execute-actions",
        async () => {
          const { dbIdMap, tweetStringIdToCluster } = assignments;
          const now = new Date().toISOString();
          const newClusterIds: number[] = [];
          const updatedClusterIds: Array<{ id: number; addedCount: number }> = [];
          const staleClusterIds = new Set<number>();

          for (const action of actions) {
            if (action.type === "create") {
              const tweetDbIds = action.tweetIds
                .map((id) => dbIdMap[id])
                .filter((id): id is number => id !== undefined);
              if (tweetDbIds.length === 0) continue;

              const tweets = (await loadTweetMeta(tweetDbIds)).filter(
                (t) => !isBlockedAccount(t.username)
              );
              const uniqueUsers = new Set(
                tweets.map((t) => (t.username ?? `id:${t.tweet_id}`).toLowerCase())
              ).size;
              const isStoryCandidate =
                tweets.length >= STORY_MIN_TWEETS && uniqueUsers >= STORY_MIN_USERS;
              const headlineTweet = pickHeadlineTweet(tweets);

              const { data: newCluster, error: createError } = await supabase
                .from("x_news_clusters")
                .insert({
                  first_seen_at: action.earliestDate ?? now,
                  last_seen_at: action.latestDate ?? now,
                  normalized_headline: headlineTweet?.normalized_headline ?? null,
                  tweet_count: tweets.length,
                  unique_user_count: uniqueUsers,
                  is_story_candidate: isStoryCandidate,
                  last_synced_at: now,
                  is_active: true,
                })
                .select("id")
                .single();

              if (createError || !newCluster) {
                console.error("Cluster create failed:", createError?.message);
                continue;
              }

              const clusterId = (newCluster as { id: number }).id;

              // Track old clusters that will lose tweets to this new cluster
              for (const tweetId of action.tweetIds) {
                const oldClusterId = tweetStringIdToCluster[tweetId];
                if (oldClusterId !== undefined) {
                  staleClusterIds.add(oldClusterId);
                }
              }

              const memberRows = tweetDbIds.map((dbId) => ({
                tweet_id: dbId,
                cluster_id: clusterId,
                assigned_at: now,
              }));

              const { error: memberError } = await supabase
                .from("x_news_cluster_tweets")
                .upsert(memberRows, { onConflict: "tweet_id" });

              if (memberError) {
                console.error("Cluster tweet insert failed:", memberError.message);
              } else {
                newClusterIds.push(clusterId);
              }
            } else {
              // type === "update"
              const { persistentClusterId, toAdd, toRemove } = action;

              // Remove departed tweets (within window)
              if (toRemove.length > 0) {
                const removeDbIds = toRemove
                  .map((id) => dbIdMap[id])
                  .filter((id): id is number => id !== undefined);
                if (removeDbIds.length > 0) {
                  const { error } = await supabase
                    .from("x_news_cluster_tweets")
                    .delete()
                    .in("tweet_id", removeDbIds)
                    .eq("cluster_id", persistentClusterId);
                  if (error) {
                    console.error("Cluster tweet delete failed:", error.message);
                  }
                }
              }

              // Add new tweets
              let addedCount = 0;
              if (toAdd.length > 0) {
                // Track old clusters that will lose tweets
                for (const tweetId of toAdd) {
                  const oldClusterId = tweetStringIdToCluster[tweetId];
                  if (oldClusterId !== undefined && oldClusterId !== persistentClusterId) {
                    staleClusterIds.add(oldClusterId);
                  }
                }

                const addDbIds = toAdd
                  .map((id) => dbIdMap[id])
                  .filter((id): id is number => id !== undefined);
                if (addDbIds.length > 0) {
                  const memberRows = addDbIds.map((dbId) => ({
                    tweet_id: dbId,
                    cluster_id: persistentClusterId,
                    assigned_at: now,
                  }));
                  const { error } = await supabase
                    .from("x_news_cluster_tweets")
                    .upsert(memberRows, { onConflict: "tweet_id" });
                  if (error) {
                    console.error("Cluster tweet upsert failed:", error.message);
                  } else {
                    addedCount = addDbIds.length;
                  }
                }
              }

              // Recompute stats
              await recomputeClusterStats(persistentClusterId, now);
              updatedClusterIds.push({ id: persistentClusterId, addedCount });
            }
          }

          // Recompute stats for old clusters that lost tweets
          for (const staleId of staleClusterIds) {
            await recomputeClusterStats(staleId, now);
          }

          return { newClusterIds, updatedClusterIds };
        }
      );

      // ── Step 5: Deactivate stale clusters ──────────────────────────────────
      await step.run("deactivate-stale-clusters", async () => {
        const staleCutoff = new Date(
          Date.now() - STALE_DEACTIVATE_HOURS * 60 * 60 * 1000
        ).toISOString();

        const { error } = await supabase
          .from("x_news_clusters")
          .update({ is_active: false })
          .eq("is_active", true)
          .is("merged_into_cluster_id", null)
          .lt("last_synced_at", staleCutoff);

        if (error) throw new Error(`Deactivate stale clusters failed: ${error.message}`);
      });

      // ── Step 6: Emit review events ─────────────────────────────────────────
      const reviewEvents = [
        ...newClusterIds.map((id) => ({
          name: "x-news/cluster.review.requested" as const,
          data: { clusterId: id },
        })),
        ...updatedClusterIds
          .filter(({ addedCount }) => addedCount >= REVIEW_MIN_NEW_MEMBERS)
          .map(({ id }) => ({
            name: "x-news/cluster.review.requested" as const,
            data: { clusterId: id },
          })),
      ];

      if (reviewEvents.length > 0) {
        await step.sendEvent("emit-review-events", reviewEvents);
      }

      const summary = {
        status: "ok",
        rpc_clusters: rpcClusters.length,
        created: newClusterIds.length,
        updated: updatedClusterIds.length,
        review_events_sent: reviewEvents.length,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-sync",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-sync",
          state: "error",
          errorMessage: message,
        });
      });
      throw error;
    }
  }
);
