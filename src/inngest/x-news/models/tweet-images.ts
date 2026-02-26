import { supabase } from "@/lib/supabase";
import type { ParsedTweetImageRow } from "../utils/asset-parser";

export type TweetImageRow = {
  id: number;
  tweet_id: string;
  image_url: string;
  image_category: string | null;
  warrants_financial_analysis: boolean | null;
  initial_claude_analysis: unknown;
  summary: string | null;
  claude_summary_payload: unknown;
};

export class TweetImagesModel {
  static async upsert(rows: ParsedTweetImageRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const { data, error } = await supabase
      .from("tweet_images")
      .upsert(rows, { onConflict: "tweet_id,image_url" })
      .select("id");

    if (error) {
      throw new Error(`Supabase tweet_images upsert failed: ${error.message}`);
    }

    return data?.length ?? 0;
  }

  static async listByTweetId(tweetId: string): Promise<TweetImageRow[]> {
    const { data, error } = await supabase
      .from("tweet_images")
      .select(
        "id,tweet_id,image_url,image_category,warrants_financial_analysis,initial_claude_analysis,summary,claude_summary_payload"
      )
      .eq("tweet_id", tweetId)
      .order("id", { ascending: true });

    if (error) {
      throw new Error(`Supabase tweet_images lookup failed: ${error.message}`);
    }

    return (data ?? []) as TweetImageRow[];
  }

  static async updateAnalysis(
    id: number,
    params: {
      imageCategory: string;
      warrantsFinancialAnalysis: boolean;
      initialClaudeAnalysis: unknown;
    }
  ): Promise<void> {
    const { error } = await supabase
      .from("tweet_images")
      .update({
        image_category: params.imageCategory,
        warrants_financial_analysis: params.warrantsFinancialAnalysis,
        initial_claude_analysis: params.initialClaudeAnalysis,
      })
      .eq("id", id);

    if (error) {
      throw new Error(`tweet_images analysis update failed: ${error.message}`);
    }
  }

  static async updateSummary(
    id: number,
    params: {
      summary: string;
      claudeSummaryPayload: unknown;
    }
  ): Promise<void> {
    const { error } = await supabase
      .from("tweet_images")
      .update({
        summary: params.summary,
        claude_summary_payload: params.claudeSummaryPayload,
      })
      .eq("id", id);

    if (error) {
      throw new Error(`tweet_images summary update failed: ${error.message}`);
    }
  }
}
