import type { Tweet } from "../services/twitterapi-io";
import {
  dedupeByKey,
  parseTweetAssets,
  type ParsedTweetImageRow,
  type ParsedTweetUrlRow,
  type ParsedTweetVideoDraft,
} from "../utils/asset-parser";
import { TweetImagesModel } from "./tweet-images";
import { TweetUrlsModel } from "./tweet-urls";
import { TweetVideosModel, type TweetVideoInsertRow } from "./tweet-videos";

export type AssetUpsertSummary = {
  images_inserted: number;
  urls_inserted: number;
  videos_inserted: number;
  videos_skipped_missing_tweet_id: number;
};

export class TweetAssetsModel {
  static async upsertFromTweets(
    tweets: Tweet[],
    tweetDbIdMap: Map<string, number>
  ): Promise<AssetUpsertSummary> {
    const allImages: ParsedTweetImageRow[] = [];
    const allUrls: ParsedTweetUrlRow[] = [];
    const allVideos: ParsedTweetVideoDraft[] = [];

    for (const tweet of tweets) {
      const assets = parseTweetAssets(tweet);
      allImages.push(...assets.images);
      allUrls.push(...assets.urls);
      allVideos.push(...assets.videos);
    }

    const images = dedupeByKey(allImages, (img) => `${img.tweet_id}|${img.image_url}`);
    const urls = dedupeByKey(allUrls, (url) => `${url.tweet_id}|${url.url}`);
    const videos = dedupeByKey(allVideos, (video) => `${video.tweet_id}|${video.media_key}`);

    const imagesInserted = await TweetImagesModel.upsert(images);
    const urlsInserted = await TweetUrlsModel.upsert(urls);

    const videosWithDbIds: TweetVideoInsertRow[] = [];
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

    const videosInserted = await TweetVideosModel.upsert(videosWithDbIds);

    return {
      images_inserted: imagesInserted,
      urls_inserted: urlsInserted,
      videos_inserted: videosInserted,
      videos_skipped_missing_tweet_id: missingTweetIds,
    };
  }
}
