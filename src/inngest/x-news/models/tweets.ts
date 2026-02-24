import { supabase } from "@/lib/supabase";
import type { TweetRow } from "../services/twitterapi-io";

const DEFAULT_UPSERT_BATCH_SIZE = 50;
const DEFAULT_CHUNK_SIZE = 200;

type SupabaseTweetIdRow = {
  id: number;
  tweet_id: string;
};

type SupabaseTweetLookupRow = {
  tweet_id: string;
  tweet_text: string | null;
  username: string | null;
};

type SupabaseNormalizedTweetRow = {
  id: number;
  tweet_id: string;
  username: string | null;
  tweet_time: string | null;
  normalized_headline: string | null;
  normalized_facts: unknown;
  normalized_headline_embedding: unknown;
};

export type InsertedTweetRef = {
  id: number;
  tweet_id: string;
};

export type TweetLookupRow = {
  tweet_id: string;
  tweet_text: string | null;
  username: string | null;
};

export type NormalizedTweetRow = {
  id: number;
  tweet_id: string;
  username: string | null;
  tweet_time: string | null;
  normalized_headline: string | null;
  normalized_facts: string[] | null;
  normalized_headline_embedding: unknown;
};

function toNormalizedFacts(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  const facts: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const cleaned = item.trim();
    if (!cleaned) continue;
    facts.push(cleaned);
  }
  return facts;
}

function mapNormalizedTweetRow(row: SupabaseNormalizedTweetRow): NormalizedTweetRow {
  return {
    id: row.id,
    tweet_id: row.tweet_id,
    username: row.username,
    tweet_time: row.tweet_time,
    normalized_headline: row.normalized_headline,
    normalized_facts: toNormalizedFacts(row.normalized_facts),
    normalized_headline_embedding: row.normalized_headline_embedding,
  };
}

export class TweetsModel {
  static async upsertReturningRefs(
    rows: TweetRow[],
    batchSize = DEFAULT_UPSERT_BATCH_SIZE
  ): Promise<InsertedTweetRef[]> {
    const inserted: InsertedTweetRef[] = [];

    for (let i = 0; i < rows.length; i += batchSize) {
      const batch = rows.slice(i, i + batchSize);
      const { data, error } = await supabase
        .from("tweets")
        .upsert(batch, { onConflict: "tweet_id", ignoreDuplicates: true })
        .select("id,tweet_id");

      if (error) {
        throw new Error(`Supabase tweet upsert failed: ${error.message}`);
      }

      for (const row of (data ?? []) as SupabaseTweetIdRow[]) {
        if (typeof row.id === "number" && typeof row.tweet_id === "string") {
          inserted.push({ id: row.id, tweet_id: row.tweet_id });
        }
      }
    }

    return inserted;
  }

  static async getDbIdMapByTweetIds(
    tweetIds: string[],
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<Map<string, number>> {
    const map = new Map<string, number>();
    if (tweetIds.length === 0) return map;

    for (let i = 0; i < tweetIds.length; i += chunkSize) {
      const chunk = tweetIds.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from("tweets")
        .select("id,tweet_id")
        .in("tweet_id", chunk);

      if (error) {
        throw new Error(`Supabase tweet id mapping failed: ${error.message}`);
      }

      for (const row of (data ?? []) as SupabaseTweetIdRow[]) {
        if (typeof row.id === "number" && typeof row.tweet_id === "string") {
          map.set(row.tweet_id, row.id);
        }
      }
    }

    return map;
  }

  static async findByTweetId(tweetId: string): Promise<TweetLookupRow | null> {
    const { data, error } = await supabase
      .from("tweets")
      .select("tweet_id,tweet_text,username")
      .eq("tweet_id", tweetId)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase tweet lookup failed: ${error.message}`);
    }

    if (!data) return null;
    const row = data as SupabaseTweetLookupRow;
    return {
      tweet_id: row.tweet_id,
      tweet_text: row.tweet_text,
      username: row.username,
    };
  }

  static async findNormalizedByTweetId(tweetId: string): Promise<NormalizedTweetRow | null> {
    const { data, error } = await supabase
      .from("tweets")
      .select(
        "id,tweet_id,username,tweet_time,normalized_headline,normalized_facts,normalized_headline_embedding"
      )
      .eq("tweet_id", tweetId)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase normalized tweet lookup failed: ${error.message}`);
    }

    if (!data) return null;
    return mapNormalizedTweetRow(data as SupabaseNormalizedTweetRow);
  }

  static async updateNormalization(params: {
    tweetId: string;
    normalizedHeadline: string;
    normalizedFacts: string[];
  }): Promise<void> {
    const { error } = await supabase
      .from("tweets")
      .update({
        normalized_headline: params.normalizedHeadline,
        normalized_facts: params.normalizedFacts,
      })
      .eq("tweet_id", params.tweetId);

    if (error) {
      throw new Error(`Supabase normalization update failed: ${error.message}`);
    }
  }

  static async updateNormalizedHeadlineEmbedding(params: {
    tweetDbId: number;
    embedding: string;
  }): Promise<void> {
    const { error } = await supabase
      .from("tweets")
      .update({
        normalized_headline_embedding: params.embedding,
      })
      .eq("id", params.tweetDbId);

    if (error) {
      throw new Error(`Tweet embedding update failed: ${error.message}`);
    }
  }
}
