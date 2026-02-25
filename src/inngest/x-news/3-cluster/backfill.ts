import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";

type BackfillEvent = {
  data: {
    limit?: number;
    lookbackHours?: number;
    allTweets?: boolean; // if true, re-queue even tweets that already have embeddings
  };
};

type TweetCandidateRow = {
  tweet_id: string;
};

const PAGE_SIZE        = 1000;
const EVENT_BATCH_SIZE = 150;
const DEFAULT_LIMIT    = 4000;
const MAX_LIMIT        = 20000;

function parsePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
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

async function loadTweetsNeedingEmbedding(
  limit: number,
  lookbackHours: number | null,
  allTweets: boolean
): Promise<TweetCandidateRow[]> {
  const rows: TweetCandidateRow[] = [];
  const cutoff = lookbackHours !== null
    ? new Date(Date.now() - lookbackHours * 60 * 60 * 1000).toISOString()
    : null;

  for (let offset = 0; rows.length < limit; offset += PAGE_SIZE) {
    let query = supabase
      .from("tweets")
      .select("tweet_id")
      .not("normalized_headline", "is", null)
      .eq("is_latest_version", true)
      .eq("is_retweet", false)
      .eq("is_reply", false)
      .eq("is_quote", false)
      .order("tweet_time", { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1);

    if (!allTweets) {
      query = query.is("normalized_headline_embedding", null);
    }

    if (cutoff) {
      query = query.gte("tweet_time", cutoff);
    }

    const { data, error } = await query;
    if (error) throw new Error(`Backfill tweet query failed: ${error.message}`);

    const batch = (data ?? []) as TweetCandidateRow[];
    if (batch.length === 0) break;

    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }

  return rows.slice(0, limit);
}

/**
 * Ensures all normalized tweets have embeddings by re-queuing them through
 * the embed step (x-news/tweet.normalized event → assign function).
 * Clustering itself is on-the-fly via cluster_tweets_by_embedding.
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
      const payload     = event as BackfillEvent;
      const requestedLimit = parsePositiveInt(payload.data?.limit, DEFAULT_LIMIT);
      const limit       = Math.min(requestedLimit, MAX_LIMIT);
      const lookbackHours  = normalizeLookbackHours(payload.data?.lookbackHours);
      const allTweets   = payload.data?.allTweets === true;

      const tweets = await step.run("load-tweets-needing-embedding", async () => {
        return loadTweetsNeedingEmbedding(limit, lookbackHours, allTweets);
      });

      const tweetIds = tweets
        .map((row) => row.tweet_id)
        .filter((id): id is string => typeof id === "string" && !!id);

      for (const [i, batch] of chunkArray(tweetIds, EVENT_BATCH_SIZE).entries()) {
        await step.sendEvent(
          `emit-backfill-events-${i + 1}`,
          batch.map((tweetId) => ({
            name: "x-news/tweet.normalized",
            data: { tweetId },
          }))
        );
      }

      const summary = {
        status: "ok",
        applied_limit: limit,
        lookback_hours: lookbackHours,
        all_tweets: allTweets,
        tweets_queued: tweetIds.length,
        batches_sent: Math.ceil(tweetIds.length / EVENT_BATCH_SIZE),
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
