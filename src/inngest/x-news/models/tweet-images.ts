import { supabase } from "@/lib/supabase";
import type { ParsedTweetImageRow } from "../utils/asset-parser";

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
}
