import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { recomputeClusterStats } from "./cluster-db";

type BackfillMode = "unassigned" | "all" | "rebuild";

type BackfillEvent = {
  data: {
    mode?: BackfillMode;
    limit?: number;
    lookbackHours?: number;
  };
};

type TweetCandidateRow = {
  id: number;
  tweet_id: string;
  tweet_time: string | null;
};

const PAGE_SIZE = 1000;
const CLUSTER_PAGE_SIZE = 500;
const ASSIGNMENT_CHECK_BATCH = 500;
const EVENT_BATCH_SIZE = 150;
const DEFAULT_LIMIT = 4000;
const MAX_LIMIT = 20000;
const MAX_CLUSTER_RECOMPUTE = 5000;

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function normalizeMode(value: string | undefined): BackfillMode {
  if (value === "all") return "all";
  if (value === "rebuild") return "rebuild";
  return "unassigned";
}

function normalizeLookbackHours(input: number | undefined): number | null {
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  const value = Math.floor(input);
  if (value <= 0) return null;
  return Math.min(value, 24 * 30);
}

function chunkArray<T>(input: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < input.length; i += size) {
    chunks.push(input.slice(i, i + size));
  }
  return chunks;
}

async function loadNormalizedTweets(limit: number, lookbackHours: number | null): Promise<TweetCandidateRow[]> {
  const rows: TweetCandidateRow[] = [];
  const cutoff =
    lookbackHours !== null
      ? new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString()
      : null;

  for (let offset = 0; rows.length < limit; offset += PAGE_SIZE) {
    let query = supabase
      .from("tweets")
      .select("id,tweet_id,tweet_time")
      .not("normalized_headline", "is", null)
      .order("tweet_time", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (cutoff) {
      query = query.gte("tweet_time", cutoff);
    }

    const { data, error } = await query;

    if (error) {
      throw new Error(`Backfill tweet query failed: ${error.message}`);
    }

    const batch = (data ?? []) as TweetCandidateRow[];
    if (batch.length === 0) break;

    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return rows.slice(0, limit);
}

async function loadAssignedTweetDbIds(tweetDbIds: number[]): Promise<number[]> {
  const assigned = new Set<number>();
  if (tweetDbIds.length === 0) return [];

  for (const chunk of chunkArray(tweetDbIds, ASSIGNMENT_CHECK_BATCH)) {
    const { data, error } = await supabase
      .from("x_news_cluster_tweets")
      .select("tweet_id")
      .in("tweet_id", chunk);

    if (error) {
      throw new Error(`Backfill assignment lookup failed: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (typeof row.tweet_id === "number") {
        assigned.add(row.tweet_id);
      }
    }
  }

  return [...assigned];
}

async function loadActiveClusterIds(limit: number): Promise<number[]> {
  const ids: number[] = [];

  for (let offset = 0; ids.length < limit; offset += CLUSTER_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("x_news_clusters")
      .select("id")
      .is("merged_into_cluster_id", null)
      .order("id", { ascending: true })
      .range(offset, offset + CLUSTER_PAGE_SIZE - 1);

    if (error) {
      throw new Error(`Backfill cluster lookup failed: ${error.message}`);
    }

    const batch = (data ?? []).flatMap((row) =>
      typeof row.id === "number" ? [row.id] : []
    );

    if (batch.length === 0) break;
    ids.push(...batch);
    if (batch.length < CLUSTER_PAGE_SIZE) break;
  }

  return ids.slice(0, limit);
}

async function recomputeAllActiveClusterStats(): Promise<number> {
  const clusterIds = await loadActiveClusterIds(MAX_CLUSTER_RECOMPUTE);
  for (const clusterId of clusterIds) {
    await recomputeClusterStats(clusterId);
  }
  return clusterIds.length;
}

async function resetClusterTables(): Promise<void> {
  const { error } = await supabase
    .from("x_news_clusters")
    .delete()
    .gt("id", 0);

  if (error) {
    throw new Error(`Cluster reset failed: ${error.message}`);
  }
}

/**
 * Backfills clustering for already-normalized tweets.
 * Triggered on-demand via API and emits x-news/tweet.normalized events.
 */
export const xNewsClusterBackfill = inngest.createFunction(
  {
    id: "x-news-cluster-backfill",
    retries: 1,
    concurrency: 1,
    timeouts: {
      finish: "10m",
    },
  },
  { event: "x-news/cluster.backfill.requested" },
  async ({ event, step }) => {
    try {
      const payload = event as BackfillEvent;
      const mode = normalizeMode(payload.data?.mode);
      const requestedLimit = parsePositiveInt(payload.data?.limit, DEFAULT_LIMIT);
      const limit = Math.min(requestedLimit, MAX_LIMIT);
      const lookbackHours = normalizeLookbackHours(payload.data?.lookbackHours);

      if (mode === "rebuild") {
        await step.run("reset-cluster-tables", async () => {
          await resetClusterTables();
        });
      }

      const normalizedTweets = await step.run("load-normalized-tweets", async () => {
        return loadNormalizedTweets(limit, lookbackHours);
      });

      let candidates = normalizedTweets;
      if (mode === "unassigned" && normalizedTweets.length > 0) {
        const assignedTweetDbIds = await step.run("load-existing-assignments", async () => {
          return loadAssignedTweetDbIds(normalizedTweets.map((row) => row.id));
        });
        const assignedSet = new Set(assignedTweetDbIds);

        candidates = normalizedTweets.filter((row) => !assignedSet.has(row.id));
      }

      const tweetIdsToQueue = candidates
        .map((row) => row.tweet_id)
        .filter((tweetId): tweetId is string => typeof tweetId === "string" && !!tweetId);

      for (const [batchIndex, batch] of chunkArray(tweetIdsToQueue, EVENT_BATCH_SIZE).entries()) {
        await step.sendEvent(
          `emit-backfill-events-${batchIndex + 1}`,
          batch.map((tweetId) => ({
            name: "x-news/tweet.normalized",
            data: { tweetId },
          }))
        );
      }

      const recomputedClusters =
        mode === "rebuild"
          ? 0
          : await step.run("recompute-active-clusters", async () => {
              return recomputeAllActiveClusterStats();
            });

      const summary = {
        status: "ok",
        mode,
        requested_limit: requestedLimit,
        applied_limit: limit,
        lookback_hours: lookbackHours,
        normalized_rows_scanned: normalizedTweets.length,
        tweets_queued: tweetIdsToQueue.length,
        batches_sent: Math.ceil(tweetIdsToQueue.length / EVENT_BATCH_SIZE),
        clusters_recomputed: recomputedClusters,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-backfill",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-backfill",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
