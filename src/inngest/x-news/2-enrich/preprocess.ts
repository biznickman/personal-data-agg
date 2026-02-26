import { inngest } from "../../client";
import { recordFunctionRun } from "../../run-status";
import {
  TweetsModel,
  TweetUrlsModel,
  TweetImagesModel,
  type TweetImageRow,
} from "../models";
import type {
  NormalizationUrlContext,
  NormalizationImageContext,
} from "../utils/normalize-prompt";
import { processTweetUrlById } from "../services/url-content";
import { classifyImage, summarizeImage } from "../services/image-analyzer";
import { normalizeStory } from "../services/story-normalizer";
import { embedTextForClustering } from "../3-cluster/embeddings";
import { stringifyVector } from "../3-cluster/vector";

type PreprocessEvent = {
  data: {
    tweetId?: string;
    reason?: string;
  };
};

type TweetUrlContextRow = {
  url: string | null;
  url_content: string | null;
};

const MAX_URL_CONTEXTS = 3;

function isUsableUrlContent(value: string | null): value is string {
  if (!value) return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("Error fetching content:")) return false;
  if (trimmed === "Could not extract readable content") return false;
  return true;
}

function toUrlContexts(rows: TweetUrlContextRow[]): NormalizationUrlContext[] {
  return rows
    .filter((row) => typeof row.url === "string" && isUsableUrlContent(row.url_content))
    .slice(0, MAX_URL_CONTEXTS)
    .map((row) => ({
      url: row.url as string,
      content: row.url_content as string,
    }));
}

function buildImageContexts(images: TweetImageRow[]): NormalizationImageContext[] {
  return images
    .filter((img) => typeof img.summary === "string" && img.summary.trim().length > 0)
    .map((img, i) => ({
      index: i + 1,
      category: img.image_category ?? "unknown",
      summary: img.summary as string,
    }));
}

/**
 * Consolidated tweet pre-processing orchestrator.
 *
 * Handles URL enrichment, image classification/summarization,
 * normalization, and embedding as sequential Inngest steps.
 */
export const xNewsTweetPreprocess = inngest.createFunction(
  {
    id: "x-news-tweet-preprocess",
    retries: 2,
    concurrency: 5,
    timeouts: {
      finish: "5m",
    },
  },
  { event: "x-news/tweet.preprocess" },
  async ({ event, step }) => {
    try {
      const payload = event as PreprocessEvent;
      const tweetId =
        typeof payload.data?.tweetId === "string" ? payload.data.tweetId : null;
      const reason =
        typeof payload.data?.reason === "string" ? payload.data.reason : "unknown";

      if (!tweetId) {
        return { status: "ok", processed: 0, skipped: 1, reason: "missing_tweet_id" };
      }

      // --- Step: load-tweet ---
      const tweetData = await step.run("load-tweet", async () => {
        const tweet = await TweetsModel.findByTweetId(tweetId);
        if (!tweet) return null;
        const normalized = await TweetsModel.findNormalizedByTweetId(tweetId);
        return { tweet, normalized };
      });

      if (!tweetData) {
        return { status: "ok", processed: 0, skipped: 1, reason: "tweet_not_found", tweet_id: tweetId };
      }

      const { tweet, normalized } = tweetData;

      // Skip if already has embedding (unless backfill)
      if (normalized?.normalized_headline_embedding && reason !== "backfill") {
        return { status: "ok", processed: 0, skipped: 1, reason: "already_embedded", tweet_id: tweetId };
      }

      // --- Step: enrich-urls ---
      const urlEnrichResult = await step.run("enrich-urls", async () => {
        const pendingUrls = await TweetUrlsModel.listPendingByTweetIds([tweetId]);
        let enriched = 0;
        let failed = 0;

        for (const row of pendingUrls) {
          try {
            await processTweetUrlById(row.id, row.url);
            enriched++;
          } catch (err) {
            console.warn(
              `URL enrichment failed for tweet_url ${row.id}: ${err instanceof Error ? err.message : String(err)}`
            );
            failed++;
          }
        }

        return { total: pendingUrls.length, enriched, failed };
      });

      // --- Step: load-images ---
      const unclassifiedImages = await step.run("load-images", async () => {
        const allImages = await TweetImagesModel.listByTweetId(tweetId);
        return allImages.filter((img) => img.image_category === null);
      });

      // --- Dynamic steps: classify each unclassified image ---
      const classifiedImages: Array<{
        id: number;
        imageUrl: string;
        category: string;
        warrantsAnalysis: boolean;
      }> = [];

      for (const image of unclassifiedImages) {
        const result = await step.run(`classify-image-${image.id}`, async () => {
          try {
            const classification = await classifyImage(image.image_url);
            await TweetImagesModel.updateAnalysis(image.id, {
              imageCategory: classification.image_category,
              warrantsFinancialAnalysis: classification.warrants_financial_analysis,
              initialClaudeAnalysis: classification,
            });
            return {
              id: image.id,
              imageUrl: image.image_url,
              category: classification.image_category,
              warrantsAnalysis: classification.warrants_financial_analysis,
            };
          } catch (err) {
            console.warn(
              `Image classification failed for image ${image.id}: ${err instanceof Error ? err.message : String(err)}`
            );
            await TweetImagesModel.updateAnalysis(image.id, {
              imageCategory: "error",
              warrantsFinancialAnalysis: false,
              initialClaudeAnalysis: {
                error: err instanceof Error ? err.message : String(err),
              },
            });
            return {
              id: image.id,
              imageUrl: image.image_url,
              category: "error",
              warrantsAnalysis: false,
            };
          }
        });

        classifiedImages.push(result);
      }

      // --- Dynamic steps: summarize images that warrant analysis ---
      const imagesToSummarize = classifiedImages.filter((img) => img.warrantsAnalysis);

      for (const image of imagesToSummarize) {
        await step.run(`summarize-image-${image.id}`, async () => {
          try {
            const summaryResult = await summarizeImage(
              image.imageUrl,
              tweet.tweet_text ?? ""
            );
            await TweetImagesModel.updateSummary(image.id, {
              summary: summaryResult.summary,
              claudeSummaryPayload: summaryResult,
            });
          } catch (err) {
            console.warn(
              `Image summarization failed for image ${image.id}: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        });
      }

      // --- Step: normalize ---
      const normalizeResult = await step.run("normalize", async () => {
        // Load fresh URL contexts + image data
        const urlRows = await TweetUrlsModel.listContextsByTweetId(tweetId);
        const urlContexts = toUrlContexts(urlRows);
        const allImages = await TweetImagesModel.listByTweetId(tweetId);
        const imageContexts = buildImageContexts(allImages);

        const tweetText = tweet.tweet_text?.trim() ?? "";

        // Allow normalization when tweet has no text BUT has image summaries
        if (!tweetText && imageContexts.length === 0) {
          return { skipped: true as const, reason: "no_content" };
        }

        const normalizedStory = await normalizeStory({
          tweetId,
          username: tweet.username,
          tweetText: tweetText || "[No tweet text — see image analysis below]",
          quotedTweetText: tweet.quoted_tweet_text,
          urlContexts,
          imageContexts,
        });

        await TweetsModel.updateNormalization({
          tweetId,
          normalizedHeadline: normalizedStory.normalizedHeadline,
          normalizedFacts: normalizedStory.normalizedFacts,
        });

        return {
          skipped: false as const,
          headline: normalizedStory.normalizedHeadline,
          factsCount: normalizedStory.normalizedFacts.length,
          urlContextsUsed: urlContexts.length,
          imageContextsUsed: imageContexts.length,
          provider: normalizedStory.provider,
          model: normalizedStory.model,
        };
      });

      if (normalizeResult.skipped) {
        return {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: normalizeResult.reason,
          tweet_id: tweetId,
          urls_enriched: urlEnrichResult.enriched,
          images_classified: classifiedImages.length,
        };
      }

      // --- Step: embed ---
      await step.run("embed", async () => {
        const freshNormalized = await TweetsModel.findNormalizedByTweetId(tweetId);
        if (!freshNormalized) {
          throw new Error(`Tweet ${tweetId} not found after normalization`);
        }

        const rawText =
          typeof freshNormalized.tweet_text === "string"
            ? freshNormalized.tweet_text.trim()
            : "";
        const headlineText =
          freshNormalized.normalized_headline?.trim() || rawText.slice(0, 240) || null;

        if (!headlineText) {
          throw new Error(`No text to embed for tweet ${tweetId}`);
        }

        const embedding = await embedTextForClustering(headlineText);
        const vector = stringifyVector(embedding);
        if (!vector) throw new Error("Embedding generation returned an empty vector");

        await TweetsModel.updateNormalizedHeadlineEmbedding({
          tweetDbId: freshNormalized.id,
          embedding: vector,
        });
      });

      const summary = {
        status: "ok",
        processed: 1,
        tweet_id: tweetId,
        trigger_reason: reason,
        urls_enriched: urlEnrichResult.enriched,
        urls_failed: urlEnrichResult.failed,
        images_classified: classifiedImages.length,
        images_summarized: imagesToSummarize.length,
        normalized_headline: normalizeResult.headline,
        normalized_facts_count: normalizeResult.factsCount,
        url_contexts_used: normalizeResult.urlContextsUsed,
        image_contexts_used: normalizeResult.imageContextsUsed,
        model_provider: normalizeResult.provider,
        model_name: normalizeResult.model,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-tweet-preprocess",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-tweet-preprocess",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
