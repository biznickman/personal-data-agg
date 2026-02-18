import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";
import { loadSources } from "./sources";
import { searchTweets, Tweet, tweetToRow, TweetRow } from "./twitter-api";

const BATCH_SIZE = 8;
const SUPABASE_INSERT_BATCH = 50;

interface SourceBatchResult {
  sourceBatch: string[];
  tweets: Tweet[];
  error?: string;
}

function getTwitterApiKey(): string {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey) {
    throw new Error("Missing TWITTERAPI_IO_KEY");
  }
  return apiKey;
}

async function getExistingTweetIds(tweetIds: string[]): Promise<Set<string>> {
  if (tweetIds.length === 0) {
    return new Set<string>();
  }

  const existing = new Set<string>();
  const chunkSize = 100;

  for (let i = 0; i < tweetIds.length; i += chunkSize) {
    const chunk = tweetIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("tweets")
      .select("tweet_id")
      .eq("is_latest_version", true)
      .in("tweet_id", chunk);

    if (error) {
      throw new Error(`Supabase query failed: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (typeof row.tweet_id === "string") {
        existing.add(row.tweet_id);
      }
    }
  }

  return existing;
}

async function insertTweets(rows: TweetRow[]): Promise<number> {
  let inserted = 0;

  for (let i = 0; i < rows.length; i += SUPABASE_INSERT_BATCH) {
    const batch = rows.slice(i, i + SUPABASE_INSERT_BATCH);
    const { data, error } = await supabase
      .from("tweets")
      .upsert(batch, { onConflict: "tweet_id", ignoreDuplicates: true })
      .select("tweet_id");

    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    inserted += data?.length ?? 0;
  }

  return inserted;
}

/**
 * X News Ingest — polls source accounts every 15 minutes
 */
export const xNewsIngest = inngest.createFunction(
  {
    id: "x-news-ingest",
    retries: 2,
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    try {
      const sources = await step.run("load-sources", async () => {
        const loaded = loadSources();
        if (loaded.length === 0) {
          throw new Error("No X sources found");
        }
        return loaded;
      });

      const batches: string[][] = [];
      for (let i = 0; i < sources.length; i += BATCH_SIZE) {
        batches.push(sources.slice(i, i + BATCH_SIZE));
      }

      const batchResults = await step.run("fetch-tweets", async () => {
        const apiKey = getTwitterApiKey();
        const results: SourceBatchResult[] = [];

        for (const batch of batches) {
          const query = batch.map((handle) => `from:${handle}`).join(" OR ");

          try {
            const result = await searchTweets(apiKey, query);
            results.push({ sourceBatch: batch, tweets: result.tweets });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Unknown error";
            console.error(
              `Error fetching X batch [${batch.slice(0, 3).join(", ")}...]: ${message}`
            );
            results.push({ sourceBatch: batch, tweets: [], error: message });
          }

          await new Promise((resolve) => setTimeout(resolve, 5500));
        }

        return results;
      });

      const allTweets = batchResults.flatMap((result) => result.tweets);
      const failedBatches = batchResults.filter((result) => !!result.error);

      let inserted = 0;
      if (allTweets.length > 0) {
        inserted = await step.run("insert-tweets", async () => {
          const tweetIds = allTweets.map((tweet) => tweet.id);
          const existing = await getExistingTweetIds(tweetIds);
          const newTweets = allTweets.filter((tweet) => !existing.has(tweet.id));
          const rows = newTweets.map((tweet) => tweetToRow(tweet));
          return insertTweets(rows);
        });
      }

      const summary = {
        status: "ok",
        fetched: allTweets.length,
        inserted,
        sources: sources.length,
        batches: batches.length,
        failed_batches: failedBatches.length,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-ingest",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-ingest",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
