import { supabase } from "@/lib/supabase";
import type { ParsedTweetUrlRow } from "../utils/asset-parser";

const DEFAULT_CHUNK_SIZE = 200;

type SupabasePendingUrlRow = {
  id: number;
  tweet_id: string;
  url: string;
};

type SupabaseTweetUrlRow = {
  id: number;
  tweet_id: string | null;
  url: string | null;
  url_content: string | null;
};

type SupabaseTweetUrlContextRow = {
  url: string | null;
  url_content: string | null;
};

export type PendingTweetUrl = {
  id: number;
  tweet_id: string;
  url: string;
};

export type TweetUrlRecord = {
  id: number;
  tweet_id: string | null;
  url: string | null;
  url_content: string | null;
};

export type TweetUrlContextRow = {
  url: string | null;
  url_content: string | null;
};

export class TweetUrlsModel {
  static async upsert(rows: ParsedTweetUrlRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const { data, error } = await supabase
      .from("tweet_urls")
      .upsert(rows, { onConflict: "tweet_id,url" })
      .select("id");

    if (error) {
      throw new Error(`Supabase tweet_urls upsert failed: ${error.message}`);
    }

    return data?.length ?? 0;
  }

  static async listPendingByTweetIds(
    tweetIds: string[],
    chunkSize = DEFAULT_CHUNK_SIZE
  ): Promise<PendingTweetUrl[]> {
    if (tweetIds.length === 0) return [];

    const rows: PendingTweetUrl[] = [];
    for (let i = 0; i < tweetIds.length; i += chunkSize) {
      const chunk = tweetIds.slice(i, i + chunkSize);
      const { data, error } = await supabase
        .from("tweet_urls")
        .select("id,tweet_id,url")
        .in("tweet_id", chunk)
        .is("url_content", null)
        .not("url", "is", null);

      if (error) {
        throw new Error(`Supabase tweet_urls lookup failed: ${error.message}`);
      }

      for (const row of (data ?? []) as SupabasePendingUrlRow[]) {
        if (
          typeof row.id === "number" &&
          typeof row.tweet_id === "string" &&
          typeof row.url === "string"
        ) {
          rows.push({
            id: row.id,
            tweet_id: row.tweet_id,
            url: row.url,
          });
        }
      }
    }

    const deduped = new Map<number, PendingTweetUrl>();
    for (const row of rows) {
      deduped.set(row.id, row);
    }
    return [...deduped.values()];
  }

  static async findById(id: number): Promise<TweetUrlRecord | null> {
    const { data, error } = await supabase
      .from("tweet_urls")
      .select("id,tweet_id,url,url_content")
      .eq("id", id)
      .maybeSingle();

    if (error) {
      throw new Error(`Supabase tweet_urls lookup failed: ${error.message}`);
    }

    if (!data) return null;
    const row = data as SupabaseTweetUrlRow;
    return {
      id: row.id,
      tweet_id: row.tweet_id,
      url: row.url,
      url_content: row.url_content,
    };
  }

  static async listContextsByTweetId(tweetId: string): Promise<TweetUrlContextRow[]> {
    const { data, error } = await supabase
      .from("tweet_urls")
      .select("url,url_content")
      .eq("tweet_id", tweetId)
      .not("url_content", "is", null)
      .order("created_at", { ascending: true });

    if (error) {
      throw new Error(`Supabase URL lookup failed: ${error.message}`);
    }

    return (data ?? []) as SupabaseTweetUrlContextRow[];
  }

  static async updateContent(params: {
    id: number;
    urlContent: string;
    rawUrlContent: string | null;
  }): Promise<void> {
    const { error } = await supabase
      .from("tweet_urls")
      .update({
        url_content: params.urlContent,
        raw_url_content: params.rawUrlContent,
      })
      .eq("id", params.id);

    if (error) {
      throw new Error(`tweet_urls update failed: ${error.message}`);
    }
  }
}
