import { inngest } from "../../client";
import { recordFunctionRun } from "../../run-status";
import {
  searchTweets,
  type Tweet,
  tweetToRow,
} from "../services/twitterapi-io";
import { getRequiredEnv } from "../utils/env";
import { dedupeTweetsById } from "../utils/tweets";
import {
  TweetAssetsModel,
  TweetUrlsModel,
  TweetsModel,
  type PendingTweetUrl,
} from "../models";

const SOURCES: string[] = [
  "AggrNews",
  "ashcrypto",
  "autismcapital",
  "blockworks_",
  "bobloukas",
  "cointelegraph",
  "cryptohayes",
  "cryptoslate",
  "crypto_briefing",
  "deitaone",
  "decryptmedia",
  "degeneratenews",
  "ericbalchunas",
  "geiger_capital",
  "jseyff",
  "kobeissiletter",
  "luckytraderHQ",
  "messaricrypto",
  "moonoverlord",
  "roundtablespace",
  "solanafloor",
  "techmeme",
  "theblockcampus",
  "theblock__",
  "thestalwart",
  "thetranscript_",
  "treenewsfeed",
  "tyler_did_it",
  "walterbloomberg",
  "watcherguru",
  "whaleinsider",
  "blocknewsdotcom",
  "bubblemaps",
  "coinbureau",
  "coingecko",
  "cryptodotnews",
  "cryptorover",
  "glassnode",
  "intangiblecoins",
  "ramahluwalia",
  "rektmando",
  "scottmelker",
  "solidintel_x",
  "tedtalksmacro",
  "tier10k",
  "tokenterminal",
  "unusual_whales",
  "xdaily",
  "xerocooleth",
  "zachxbt",
];

const BATCH_SIZE = 8;

interface SourceBatchResult {
  sourceBatch: string[];
  tweets: Tweet[];
  error?: string;
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
        const loaded = [...SOURCES];
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
        const apiKey = getRequiredEnv("TWITTERAPI_IO_KEY");
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
      let pendingUrlsToEnrich: PendingTweetUrl[] = [];
      if (allTweets.length > 0) {
        const result = await step.run("insert-tweets-and-assets", async () => {
          const dedupedTweets = dedupeTweetsById(allTweets);
          const rows = dedupedTweets.map((tweet) => tweetToRow(tweet));
          const insertedRefs = await TweetsModel.upsertReturningRefs(rows);

          if (insertedRefs.length === 0) {
            return {
              inserted: 0,
              newTweetsCount: 0,
              insertedAssets,
              insertedTweetIds: [] as string[],
              pendingUrlsToEnrich: [] as PendingTweetUrl[],
            };
          }

          const insertedTweetIds = new Set(insertedRefs.map((ref) => ref.tweet_id));
          const newTweets = dedupedTweets.filter((tweet) => insertedTweetIds.has(tweet.id));
          const tweetDbIdMap = new Map(insertedRefs.map((ref) => [ref.tweet_id, ref.id]));
          const assets = await TweetAssetsModel.upsertFromTweets(newTweets, tweetDbIdMap);
          const pendingUrls = await TweetUrlsModel.listPendingByTweetIds(
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
