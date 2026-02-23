import { supabase } from "@/lib/supabase";
import type { Tweet, TweetMedia, TweetVideoVariant } from "./twitter-api";

type InsertTweetImageRow = {
  tweet_id: string;
  image_url: string;
};

type InsertTweetUrlRow = {
  tweet_id: string;
  url: string;
};

type InsertTweetVideoDraft = {
  tweet_id: string;
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

type InsertTweetVideoRow = {
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

export type AssetUpsertSummary = {
  images_inserted: number;
  urls_inserted: number;
  videos_inserted: number;
  videos_skipped_missing_tweet_id: number;
};

export type PendingTweetUrl = {
  id: number;
  tweet_id: string;
  url: string;
};

const SKIP_URL_HOSTS = new Set([
  "x.com",
  "twitter.com",
  "www.twitter.com",
  "www.x.com",
  "t.co",
  "youtube.com",
  "www.youtube.com",
  "youtu.be",
]);

function normalizeExpandedUrl(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (SKIP_URL_HOSTS.has(parsed.hostname.toLowerCase())) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

function bucketVideoUrls(variants: TweetVideoVariant[]): {
  url_320: string | null;
  url_480: string | null;
  url_720: string | null;
  url_1080: string | null;
} {
  let url_320: string | null = null;
  let url_480: string | null = null;
  let url_720: string | null = null;
  let url_1080: string | null = null;

  for (const variant of variants) {
    if (!variant.url || variant.content_type !== "video/mp4") continue;

    if (/320/.test(variant.url) && !url_320) {
      url_320 = variant.url;
    } else if (/480/.test(variant.url) && !url_480) {
      url_480 = variant.url;
    } else if (/720/.test(variant.url) && !url_720) {
      url_720 = variant.url;
    } else if (/1080/.test(variant.url) && !url_1080) {
      url_1080 = variant.url;
    }
  }

  // Fallback: if we couldn't identify a resolution bucket, keep one mp4 URL.
  if (!url_320 && !url_480 && !url_720 && !url_1080) {
    const fallback = variants.find((v) => v.url && v.content_type === "video/mp4")?.url ?? null;
    url_720 = fallback;
  }

  return { url_320, url_480, url_720, url_1080 };
}

function getTweetMedia(tweet: Tweet): TweetMedia[] {
  const extended = tweet.extendedEntities?.media;
  if (Array.isArray(extended) && extended.length > 0) {
    return extended;
  }

  const baseMedia = tweet.entities?.media;
  if (Array.isArray(baseMedia) && baseMedia.length > 0) {
    return baseMedia;
  }

  return [];
}

function extractAssetsFromTweet(tweet: Tweet): {
  images: InsertTweetImageRow[];
  urls: InsertTweetUrlRow[];
  videos: InsertTweetVideoDraft[];
} {
  const images: InsertTweetImageRow[] = [];
  const urls: InsertTweetUrlRow[] = [];
  const videos: InsertTweetVideoDraft[] = [];

  const media = getTweetMedia(tweet);

  media.forEach((item, index) => {
    const mediaType = String(item.type ?? "").toLowerCase();
    const width = item.width ?? item.original_info?.width ?? null;
    const height = item.height ?? item.original_info?.height ?? null;

    if (mediaType === "photo") {
      const imageUrl = item.media_url_https ?? item.url ?? null;
      if (imageUrl) {
        images.push({ tweet_id: tweet.id, image_url: imageUrl });
      }
      return;
    }

    if (mediaType === "video" || mediaType === "animated_gif") {
      const variants = item.video_info?.variants ?? item.variants ?? [];
      const urlsByRes = bucketVideoUrls(variants);

      videos.push({
        tweet_id: tweet.id,
        preview_image_url: item.preview_image_url ?? item.media_url_https ?? null,
        duration_ms: item.duration_ms ?? null,
        width,
        height,
        media_key: item.media_key ?? `${tweet.id}-video-${index}`,
        raw_variants: variants.length > 0 ? variants : null,
        ...urlsByRes,
      });
    }
  });

  const entityUrls = tweet.entities?.urls ?? [];
  for (const entity of entityUrls) {
    const normalized = normalizeExpandedUrl(entity.expanded_url ?? entity.url);
    if (!normalized) continue;
    urls.push({ tweet_id: tweet.id, url: normalized });
  }

  return { images, urls, videos };
}

function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return [...map.values()];
}

export async function getTweetDbIdMap(tweetIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (tweetIds.length === 0) return map;

  const chunkSize = 200;
  for (let i = 0; i < tweetIds.length; i += chunkSize) {
    const chunk = tweetIds.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from("tweets")
      .select("id,tweet_id")
      .in("tweet_id", chunk);

    if (error) {
      throw new Error(`Supabase tweet id mapping failed: ${error.message}`);
    }

    for (const row of data ?? []) {
      if (typeof row.tweet_id === "string" && typeof row.id === "number") {
        map.set(row.tweet_id, row.id);
      }
    }
  }

  return map;
}

export async function upsertTweetAssets(
  tweets: Tweet[],
  tweetDbIdMap: Map<string, number>
): Promise<AssetUpsertSummary> {
  const allImages: InsertTweetImageRow[] = [];
  const allUrls: InsertTweetUrlRow[] = [];
  const allVideos: InsertTweetVideoDraft[] = [];

  for (const tweet of tweets) {
    const assets = extractAssetsFromTweet(tweet);
    allImages.push(...assets.images);
    allUrls.push(...assets.urls);
    allVideos.push(...assets.videos);
  }

  const images = dedupeByKey(allImages, (img) => `${img.tweet_id}|${img.image_url}`);
  const urls = dedupeByKey(allUrls, (url) => `${url.tweet_id}|${url.url}`);
  const videos = dedupeByKey(allVideos, (video) => `${video.tweet_id}|${video.media_key}`);

  let imagesInserted = 0;
  let urlsInserted = 0;
  let videosInserted = 0;

  if (images.length > 0) {
    const { data, error } = await supabase
      .from("tweet_images")
      .upsert(images, { onConflict: "tweet_id,image_url" })
      .select("id");

    if (error) {
      throw new Error(`Supabase tweet_images upsert failed: ${error.message}`);
    }
    imagesInserted = data?.length ?? 0;
  }

  if (urls.length > 0) {
    const { data, error } = await supabase
      .from("tweet_urls")
      .upsert(urls, { onConflict: "tweet_id,url" })
      .select("id");

    if (error) {
      throw new Error(`Supabase tweet_urls upsert failed: ${error.message}`);
    }
    urlsInserted = data?.length ?? 0;
  }

  const videosWithDbIds: InsertTweetVideoRow[] = [];
  let missingTweetIds = 0;
  for (const video of videos) {
    const dbId = tweetDbIdMap.get(video.tweet_id);
    if (!dbId) {
      missingTweetIds += 1;
      continue;
    }
    videosWithDbIds.push({
      tweet_id: dbId,
      preview_image_url: video.preview_image_url,
      duration_ms: video.duration_ms,
      width: video.width,
      height: video.height,
      media_key: video.media_key,
      url_320: video.url_320,
      url_480: video.url_480,
      url_720: video.url_720,
      url_1080: video.url_1080,
      raw_variants: video.raw_variants,
    });
  }

  if (videosWithDbIds.length > 0) {
    const { data, error } = await supabase
      .from("tweet_videos")
      .upsert(videosWithDbIds, { onConflict: "tweet_id,media_key" })
      .select("id");

    if (error) {
      throw new Error(`Supabase tweet_videos upsert failed: ${error.message}`);
    }
    videosInserted = data?.length ?? 0;
  }

  return {
    images_inserted: imagesInserted,
    urls_inserted: urlsInserted,
    videos_inserted: videosInserted,
    videos_skipped_missing_tweet_id: missingTweetIds,
  };
}

export async function getPendingTweetUrlsByTweetIds(
  tweetIds: string[]
): Promise<PendingTweetUrl[]> {
  if (tweetIds.length === 0) return [];

  const rows: PendingTweetUrl[] = [];
  const chunkSize = 200;

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

    for (const row of data ?? []) {
      if (
        typeof row.id === "number" &&
        typeof row.tweet_id === "string" &&
        typeof row.url === "string"
      ) {
        rows.push({ id: row.id, tweet_id: row.tweet_id, url: row.url });
      }
    }
  }

  const deduped = new Map<number, PendingTweetUrl>();
  for (const row of rows) {
    deduped.set(row.id, row);
  }
  return [...deduped.values()];
}
