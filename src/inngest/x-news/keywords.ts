import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { searchTweetsPaginated, tweetToRow } from "./twitter-api";

const KEYWORD_QUERY = `"fed chair" OR "crypto market" OR "bitcoin" OR "market structure" OR "solana" OR "ethereum" OR "xrp" OR "brian armstrong" OR "coinbase" OR "okx" OR "kraken" OR "blockchain" OR "tether" lang:en min_faves:50 -filter:retweets`;

async function getExistingTweetIds(tweetIds: string[]): Promise<Set<string>> {
  const existing = new Set<string>();
  const chunkSize = 100;

  for (let i = 0; i < tweetIds.length; i += chunkSize) {
    const chunk = tweetIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("tweets")
      .select("tweet_id")
      .eq("is_latest_version", true)
      .in("tweet_id", chunk);

    if (!error && data) {
      data.forEach((r) => existing.add(r.tweet_id));
    }
  }

  return existing;
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
    const allTweets = await step.run("search-keywords", async () => {
      const apiKey = process.env.TWITTERAPI_IO_KEY!;
      return searchTweetsPaginated(apiKey, KEYWORD_QUERY, 2);
    });

    if (allTweets.length === 0) {
      return { status: "ok", fetched: 0, inserted: 0 };
    }

    const inserted = await step.run("insert-tweets", async () => {
      const tweetIds = allTweets.map((t) => t.id);
      const existing = await getExistingTweetIds(tweetIds);
      const newTweets = allTweets.filter((t) => !existing.has(t.id));

      if (newTweets.length === 0) return 0;

      const rows = newTweets.map((t) => tweetToRow(t, "keywords"));

      let count = 0;
      for (let i = 0; i < rows.length; i += 50) {
        const batch = rows.slice(i, i + 50);
        const { data, error } = await supabase
          .from("tweets")
          .upsert(batch, { onConflict: "tweet_id", ignoreDuplicates: true })
          .select("tweet_id");

        if (!error && data) count += data.length;
      }
      return count;
    });

    return { status: "ok", fetched: allTweets.length, inserted };
  }
);
