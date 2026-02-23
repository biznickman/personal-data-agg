import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { searchTweetsPaginated, tweetToRow, Tweet, TweetRow } from "./twitter-api";
import { getPendingTweetUrlsByTweetIds, upsertTweetAssets } from "./assets";

const KEYWORD_QUERY =
  `"fed chair" OR "crypto market" OR "bitcoin" OR "market structure" OR "solana" OR "ethereum" OR "xrp" OR "brian armstrong" OR "coinbase" OR "okx" OR "kraken" OR "blockchain" OR "tether" lang:en min_faves:50 -filter:retweets`;

const UPSERT_BATCH_SIZE = 50;

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

async function upsertTweets(rows: TweetRow[]): Promise<InsertedTweetRef[]> {
  const inserted: InsertedTweetRef[] = [];

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
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
 * X Keyword Scan — searches crypto keywords every hour
 */
export const xKeywordScan = inngest.createFunction(
  {
    id: "x-keyword-scan",
    retries: 2,
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    try {
      const allTweets = await step.run("search-keywords", async () => {
        const apiKey = getTwitterApiKey();
        return searchTweetsPaginated(apiKey, KEYWORD_QUERY, 2);
      });

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
          const insertedRefs = await upsertTweets(rows);

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
            data: { tweetId, reason: "keywords" },
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
        url_enrichment_events_sent: pendingUrlsToEnrich.length,
        normalization_events_sent: tweetIdsToNormalize.length,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-keyword-scan",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-keyword-scan",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
