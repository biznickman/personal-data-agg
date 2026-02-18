import { inngest } from "../client";
import { supabase } from "@/lib/supabase";
import { loadSources } from "./sources";
import { searchTweets, tweetToRow } from "./twitter-api";

const BATCH_SIZE = 8; // accounts per search query
const SUPABASE_INSERT_BATCH = 50;

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

async function insertTweets(rows: ReturnType<typeof tweetToRow>[]) {
  let inserted = 0;

  for (let i = 0; i < rows.length; i += SUPABASE_INSERT_BATCH) {
    const batch = rows.slice(i, i + SUPABASE_INSERT_BATCH);
    const { data, error } = await supabase
      .from("tweets")
      .upsert(batch, { onConflict: "tweet_id", ignoreDuplicates: true })
      .select("tweet_id");

    if (error) {
      console.error(`Supabase insert error: ${error.message}`);
      continue;
    }
    inserted += data?.length ?? 0;
  }

  return inserted;
}

/**
 * X News Ingest — polls 49 source accounts every 15 minutes
 */
export const xNewsIngest = inngest.createFunction(
  {
    id: "x-news-ingest",
    retries: 2,
  },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const sources = await step.run("load-sources", async () => {
      return loadSources();
    });

    // Batch sources into OR queries
    const batches: string[][] = [];
    for (let i = 0; i < sources.length; i += BATCH_SIZE) {
      batches.push(sources.slice(i, i + BATCH_SIZE));
    }

    // Fetch tweets from all batches
    const allTweets = await step.run("fetch-tweets", async () => {
      const apiKey = process.env.TWITTERAPI_IO_KEY!;
      const tweets: ReturnType<typeof searchTweets> extends Promise<infer R>
        ? R extends { tweets: infer T }
          ? T
          : never
        : never = [];

      for (const batch of batches) {
        const query = batch.map((h) => `from:${h}`).join(" OR ");
        try {
          const result = await searchTweets(apiKey, query);
          tweets.push(...result.tweets);
          // Rate limit: 1 req per 5 seconds
          await new Promise((r) => setTimeout(r, 5500));
        } catch (err: any) {
          console.error(
            `Error on batch [${batch.slice(0, 3).join(", ")}...]: ${err.message}`
          );
        }
      }

      return tweets;
    });

    if (allTweets.length === 0) {
      return { status: "ok", fetched: 0, inserted: 0 };
    }

    // Deduplicate and insert
    const inserted = await step.run("insert-tweets", async () => {
      const tweetIds = allTweets.map((t: any) => t.id);
      const existing = await getExistingTweetIds(tweetIds);
      const newTweets = allTweets.filter((t: any) => !existing.has(t.id));

      if (newTweets.length === 0) return 0;

      const rows = newTweets.map((t: any) => tweetToRow(t));
      return insertTweets(rows);
    });

    return {
      status: "ok",
      fetched: allTweets.length,
      inserted,
      sources: sources.length,
      batches: batches.length,
    };
  }
);
