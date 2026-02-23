import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { loadSources } from "./sources";
import { searchTweets, Tweet, tweetToRow, TweetRow } from "./twitter-api";
import { getPendingTweetUrlsByTweetIds, upsertTweetAssets } from "./assets";

const BATCH_SIZE = 8;
const SUPABASE_INSERT_BATCH = 50;

interface SourceBatchResult {
  sourceBatch: string[];
  tweets: Tweet[];
  error?: string;
}

interface InsertedTweetRef {
  id: number;
  tweet_id: string;
}

function getTwitterApiKey(): string {
  const apiKey = process.env.TWITTERAPI_IO_KEY;
  if (!apiKey) {
    throw new Error("Missing TWITTERAPI_IO_KEY");
  }
  return apiKey;
}

function dedupeTweetsById(tweets: Tweet[]): Tweet[] {
  const map = new Map<string, Tweet>();
  for (const tweet of tweets) {
    if (tweet.id) {
      map.set(tweet.id, tweet);
    }
  }
  return [...map.values()];
}

async function insertTweets(rows: TweetRow[]): Promise<InsertedTweetRef[]> {
  const inserted: InsertedTweetRef[] = [];

  for (let i = 0; i < rows.length; i += SUPABASE_INSERT_BATCH) {
    const batch = rows.slice(i, i + SUPABASE_INSERT_BATCH);
    const { data, error } = await supabase
      .from("tweets")
      .upsert(batch, { onConflict: "tweet_id", ignoreDuplicates: true })
      .select("id,tweet_id");

    if (error) {
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (typeof row.tweet_id === "string" && typeof row.id === "number") {
        inserted.push({ id: row.id, tweet_id: row.tweet_id });
      }
    }
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
      let insertedAssets = {
        images_inserted: 0,
        urls_inserted: 0,
        videos_inserted: 0,
        videos_skipped_missing_tweet_id: 0,
      };
      let newTweetsCount = 0;
      let insertedTweetIds: string[] = [];
      let pendingUrlsToEnrich: { id: number; tweet_id: string; url: string }[] = [];
      if (allTweets.length > 0) {
        const result = await step.run("insert-tweets-and-assets", async () => {
          const dedupedTweets = dedupeTweetsById(allTweets);
          const rows = dedupedTweets.map((tweet) => tweetToRow(tweet));
          const insertedRefs = await insertTweets(rows);

          if (insertedRefs.length === 0) {
            return {
              inserted: 0,
              newTweetsCount: 0,
              insertedAssets,
              insertedTweetIds: [] as string[],
              pendingUrlsToEnrich: [] as { id: number; tweet_id: string; url: string }[],
            };
          }

          const insertedTweetIds = new Set(insertedRefs.map((ref) => ref.tweet_id));
          const newTweets = dedupedTweets.filter((tweet) => insertedTweetIds.has(tweet.id));
          const tweetDbIdMap = new Map(insertedRefs.map((ref) => [ref.tweet_id, ref.id]));
          const assets = await upsertTweetAssets(newTweets, tweetDbIdMap);
          const pendingUrls = await getPendingTweetUrlsByTweetIds(
            insertedRefs.map((ref) => ref.tweet_id)
          );

          return {
            inserted: insertedRefs.length,
            newTweetsCount: newTweets.length,
            insertedAssets: assets,
            insertedTweetIds: insertedRefs.map((ref) => ref.tweet_id),
            pendingUrlsToEnrich: pendingUrls,
          };
        });

        inserted = result.inserted;
        newTweetsCount = result.newTweetsCount;
        insertedAssets = result.insertedAssets;
        insertedTweetIds = result.insertedTweetIds;
        pendingUrlsToEnrich = result.pendingUrlsToEnrich;
      }

      if (pendingUrlsToEnrich.length > 0) {
        await step.sendEvent(
          "enqueue-url-enrichment",
          pendingUrlsToEnrich.map((row) => ({
            name: "x-news/url.enrich",
            data: {
              tweetUrlId: row.id,
              url: row.url,
            },
          }))
        );
      }

      const tweetIdsWithPendingUrls = new Set(
        pendingUrlsToEnrich.map((row) => row.tweet_id)
      );
      const tweetIdsToNormalize = insertedTweetIds.filter(
        (tweetId) => !tweetIdsWithPendingUrls.has(tweetId)
      );
      if (tweetIdsToNormalize.length > 0) {
        await step.sendEvent(
          "enqueue-normalization",
          tweetIdsToNormalize.map((tweetId) => ({
            name: "x-news/tweet.normalize",
            data: { tweetId, reason: "ingest" },
          }))
        );
      }

      const summary = {
        status: "ok",
        fetched: allTweets.length,
        inserted,
        new_tweets: newTweetsCount,
        asset_images_upserted: insertedAssets.images_inserted,
        asset_urls_upserted: insertedAssets.urls_inserted,
        asset_videos_upserted: insertedAssets.videos_inserted,
        asset_videos_skipped_missing_tweet_id:
          insertedAssets.videos_skipped_missing_tweet_id,
        sources: sources.length,
        batches: batches.length,
        failed_batches: failedBatches.length,
        url_enrichment_events_sent: pendingUrlsToEnrich.length,
        normalization_events_sent: tweetIdsToNormalize.length,
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
