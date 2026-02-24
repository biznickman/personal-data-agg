import { supabase } from "@/lib/supabase";
import type { TweetVideoVariant } from "../services/twitterapi-io";

export type TweetVideoInsertRow = {
  tweet_id: number;
  preview_image_url: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  media_key: string;
  url_320: string | null;
  url_480: string | null;
  url_720: string | null;
  url_1080: string | null;
  raw_variants: TweetVideoVariant[] | null;
};

export class TweetVideosModel {
  static async upsert(rows: TweetVideoInsertRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const { data, error } = await supabase
      .from("tweet_videos")
      .upsert(rows, { onConflict: "tweet_id,media_key" })
      .select("id");

    if (error) {
      throw new Error(`Supabase tweet_videos upsert failed: ${error.message}`);
    }

    return data?.length ?? 0;
  }
}
