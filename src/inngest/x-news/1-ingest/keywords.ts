import { inngest } from "../../client";
import { recordFunctionRun } from "../../run-status";
import {
  tweetToRow,
} from "../services/twitterapi-io";
import { getRequiredEnv } from "../utils/env";
import { dedupeTweetsById } from "../utils/tweets";
import { fetchTweetsForKeywordQuery } from "../operations/fetch-tweets";
import {
  TweetAssetsModel,
  TweetUrlsModel,
  TweetsModel,
  type PendingTweetUrl,
} from "../models";

const KEYWORD_QUERY =
  `"fed chair" OR "crypto market" OR "bitcoin" OR "market structure" OR "solana" OR "ethereum" OR "xrp" OR "brian armstrong" OR "coinbase" OR "okx" OR "kraken" OR "blockchain" OR "tether" lang:en min_faves:50 -filter:retweets`;

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
        const apiKey = getRequiredEnv("TWITTERAPI_IO_KEY");
        return fetchTweetsForKeywordQuery({
          apiKey,
          query: KEYWORD_QUERY,
          pages: 2,
        });
      });

      let inserted = 0;
      let insertedAssets = {
        images_inserted: 0,
        urls_inserted: 0,
        videos_inserted: 0,
        videos_skipped_missing_tweet_id: 0,
      };
      let newTweetsCount = 0;
      let tweetIdsToNormalize: string[] = [];
      let pendingUrlsToEnrich: PendingTweetUrl[] = [];
      if (allTweets.length > 0) {
        const result = await step.run("insert-tweets-and-assets", async () => {
          const dedupedTweets = dedupeTweetsById(allTweets);
          const rows = dedupedTweets.map((tweet) => tweetToRow(tweet));
          const insertedRefs = await TweetsModel.upsertReturningRefs(rows);
          const ingestedTweetIds = dedupedTweets.map((tweet) => tweet.id);

          const insertedTweetIdSet = new Set(insertedRefs.map((ref) => ref.tweet_id));
          const newTweets = dedupedTweets.filter((tweet) => insertedTweetIdSet.has(tweet.id));
          const tweetDbIdMap = new Map(insertedRefs.map((ref) => [ref.tweet_id, ref.id]));
          const assets =
            newTweets.length > 0
              ? await TweetAssetsModel.upsertFromTweets(newTweets, tweetDbIdMap)
              : insertedAssets;
          const pendingUrls = await TweetUrlsModel.listPendingByTweetIds(
            ingestedTweetIds
          );
          const unnormalizedTweetIds = await TweetsModel.listUnnormalizedTweetIds(
            ingestedTweetIds
          );
          const tweetIdsWithPendingUrls = new Set(
            pendingUrls.map((row) => row.tweet_id)
          );
          const tweetIdsToNormalize = unnormalizedTweetIds.filter(
            (tweetId) => !tweetIdsWithPendingUrls.has(tweetId)
          );

          return {
            inserted: insertedRefs.length,
            newTweetsCount: newTweets.length,
            insertedAssets: assets,
            tweetIdsToNormalize,
            pendingUrlsToEnrich: pendingUrls,
          };
        });

        inserted = result.inserted;
        newTweetsCount = result.newTweetsCount;
        insertedAssets = result.insertedAssets;
        tweetIdsToNormalize = result.tweetIdsToNormalize;
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
