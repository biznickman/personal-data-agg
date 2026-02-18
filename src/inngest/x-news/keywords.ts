import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../run-status";
import { searchTweetsPaginated, tweetToRow, Tweet, TweetRow } from "./twitter-api";

const KEYWORD_QUERY =
  `"fed chair" OR "crypto market" OR "bitcoin" OR "market structure" OR "solana" OR "ethereum" OR "xrp" OR "brian armstrong" OR "coinbase" OR "okx" OR "kraken" OR "blockchain" OR "tether" lang:en min_faves:50 -filter:retweets`;

const UPSERT_BATCH_SIZE = 50;

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

async function upsertTweets(rows: TweetRow[]): Promise<number> {
  let inserted = 0;

  for (let i = 0; i < rows.length; i += UPSERT_BATCH_SIZE) {
    const batch = rows.slice(i, i + UPSERT_BATCH_SIZE);
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
      if (allTweets.length > 0) {
        inserted = await step.run("insert-tweets", async () => {
          const tweetIds = allTweets.map((tweet: Tweet) => tweet.id);
          const existing = await getExistingTweetIds(tweetIds);
          const newTweets = allTweets.filter((tweet) => !existing.has(tweet.id));
          const rows = newTweets.map((tweet) => tweetToRow(tweet, "keywords"));
          return upsertTweets(rows);
        });
      }

      const summary = {
        status: "ok",
        fetched: allTweets.length,
        inserted,
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
