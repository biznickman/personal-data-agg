import type { Tweet, TweetMedia, TweetVideoVariant } from "../services/twitterapi-io";

export type ParsedTweetImageRow = {
  tweet_id: string;
  image_url: string;
};

export type ParsedTweetUrlRow = {
  tweet_id: string;
  url: string;
};

export type ParsedTweetVideoDraft = {
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

export type ParsedTweetAssets = {
  images: ParsedTweetImageRow[];
  urls: ParsedTweetUrlRow[];
  videos: ParsedTweetVideoDraft[];
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

export function parseTweetAssets(tweet: Tweet): ParsedTweetAssets {
  const images: ParsedTweetImageRow[] = [];
  const urls: ParsedTweetUrlRow[] = [];
  const videos: ParsedTweetVideoDraft[] = [];

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

export function dedupeByKey<T>(items: T[], keyFn: (item: T) => string): T[] {
  const map = new Map<string, T>();
  for (const item of items) {
    map.set(keyFn(item), item);
  }
  return [...map.values()];
}

