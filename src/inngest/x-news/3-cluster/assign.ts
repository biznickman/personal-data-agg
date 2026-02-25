import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { TweetsModel } from "../models";
import { recomputeClusterStats } from "./cluster-db";
import {
  jaccardSimilarity,
  mergeTokenSets,
  parseNormalizedFacts,
  parseTokenSet,
  tokenizeCanonicalText,
} from "./tokenize";
import {
  embedTextForClustering,
  getEmbeddingModel,
} from "./embeddings";
import {
  cosineSimilarity,
  parseVector,
  stringifyVector,
  weightedAverageVector,
} from "./vector";

type NormalizeEvent = {
  data: {
    tweetId?: string;
  };
};

type ClusterRow = {
  id: number;
  token_set: unknown;
  last_seen_at: string | null;
  tweet_count: number | null;
  centroid_embedding: unknown;
};

interface BestMatch {
  cluster: ClusterRow;
  similarity: number;
  clusterTokens: string[];
  clusterEmbedding: number[] | null;
  lexicalSimilarity: number | null;
}

function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CLUSTER_ASSIGN_THRESHOLD = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_ASSIGN_THRESHOLD_EMBEDDING,
  0.76
);
const CLUSTER_ASSIGN_MIN_LEXICAL_OVERLAP = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_ASSIGN_MIN_LEXICAL_OVERLAP_EMBEDDING,
  0.08
);
const CLUSTER_LOOKBACK_HOURS = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_LOOKBACK_HOURS,
  48
);
const CLUSTER_MAX_CANDIDATES = Math.floor(
  parsePositiveNumber(process.env.X_NEWS_CLUSTER_MAX_CANDIDATES, 200)
);

function chooseLastSeen(existing: string | null, incoming: string): string {
  if (!existing) return incoming;
  const existingMs = new Date(existing).getTime();
  const incomingMs = new Date(incoming).getTime();
  if (Number.isNaN(existingMs)) return incoming;
  if (Number.isNaN(incomingMs)) return existing;
  return incomingMs > existingMs ? incoming : existing;
}

function pickEventTimestamp(tweetTime: string | null): string {
  if (!tweetTime) return new Date().toISOString();
  const parsed = new Date(tweetTime);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString();
  return parsed.toISOString();
}

function findBestMatch(params: {
  tokens: string[];
  tweetEmbedding: number[];
  clusters: ClusterRow[];
}): BestMatch | null {
  const { tokens, tweetEmbedding, clusters } = params;
  let best: BestMatch | null = null;

  for (const cluster of clusters) {
    const clusterEmbedding = parseVector(cluster.centroid_embedding);
    if (!clusterEmbedding) continue;

    const clusterTokens = parseTokenSet(cluster.token_set);
    const lexicalSimilarity =
      tokens.length > 0 && clusterTokens.length > 0
        ? jaccardSimilarity(tokens, clusterTokens)
        : 0;
    if (tokens.length > 0 && lexicalSimilarity < CLUSTER_ASSIGN_MIN_LEXICAL_OVERLAP) {
      continue;
    }

    const similarity = cosineSimilarity(tweetEmbedding, clusterEmbedding);
    if (!best || similarity > best.similarity) {
      best = { cluster, similarity, clusterTokens, clusterEmbedding, lexicalSimilarity };
    }
  }

  return best;
}

async function assignTweetToCluster(
  tweetDbId: number,
  clusterId: number,
  similarity: number | null
): Promise<void> {
  const { error } = await supabase.from("x_news_cluster_tweets").upsert(
    {
      tweet_id: tweetDbId,
      cluster_id: clusterId,
      assigned_at: new Date().toISOString(),
      similarity_score: similarity,
    },
    { onConflict: "tweet_id" }
  );

  if (error) {
    throw new Error(`Cluster assignment upsert failed: ${error.message}`);
  }
}

function headlineForEmbedding(headline: string | null): string | null {
  if (typeof headline !== "string") return null;
  const cleaned = headline.trim();
  return cleaned || null;
}

/**
 * Assigns normalized tweets to existing or new clusters using embedding cosine similarity.
 * A lexical pre-filter (Jaccard token overlap) guards against false positives before
 * the embedding comparison.
 */
export const xNewsClusterAssign = inngest.createFunction(
  {
    id: "x-news-cluster-assign",
    retries: 1,
    concurrency: 5,
    timeouts: {
      finish: "2m",
    },
  },
  { event: "x-news/tweet.normalized" },
  async ({ event, step }) => {
    try {
      const payload = event as NormalizeEvent;
      const tweetId =
        typeof payload.data?.tweetId === "string" ? payload.data.tweetId : null;

      if (!tweetId) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "missing_tweet_id",
        };

        await step.run("record-success-missing-id", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-assign",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const tweet = await step.run("load-normalized-tweet", async () => {
        return TweetsModel.findNormalizedByTweetId(tweetId);
      });

      if (!tweet) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "tweet_not_found",
          tweet_id: tweetId,
        };

        await step.run("record-success-not-found", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-assign",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const existing = await step.run("check-existing-assignment", async () => {
        const { data, error } = await supabase
          .from("x_news_cluster_tweets")
          .select("cluster_id")
          .eq("tweet_id", tweet.id)
          .maybeSingle();

        if (error) {
          throw new Error(`Assignment lookup failed: ${error.message}`);
        }

        return data as { cluster_id: number } | null;
      });

      if (existing?.cluster_id) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "already_assigned",
          tweet_id: tweet.tweet_id,
          cluster_id: existing.cluster_id,
        };

        await step.run("record-success-already-assigned", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-assign",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const facts = parseNormalizedFacts(tweet.normalized_facts);
      const canonicalText = (tweet.normalized_headline ?? "").trim();
      let tokens = tokenizeCanonicalText(canonicalText);

      // Fallback: if normalization produced no tokens, try raw tweet_text
      const rawText = typeof tweet.tweet_text === "string" ? tweet.tweet_text.trim() : "";
      let usedRawFallback = false;
      if (tokens.length === 0 && rawText.length > 0) {
        tokens = tokenizeCanonicalText(rawText.slice(0, 240));
        usedRawFallback = true;
      }

      let tweetEmbedding = parseVector(tweet.normalized_headline_embedding);
      if (!tweetEmbedding) {
        let headlineText = headlineForEmbedding(tweet.normalized_headline);

        // Fallback: if normalized headline is empty, use raw tweet_text for embedding
        if (!headlineText && rawText.length > 0) {
          headlineText = rawText.slice(0, 240);
          usedRawFallback = true;
        }

        if (!headlineText) {
          const summary = {
            status: "ok",
            processed: 0,
            skipped: 1,
            reason: "missing_headline_for_embedding",
            tweet_id: tweet.tweet_id,
          };

          await step.run("record-success-missing-headline", async () => {
            await recordFunctionRun({
              functionId: "x-news-cluster-assign",
              state: "ok",
              details: summary,
            });
          });

          return summary;
        }

        tweetEmbedding = await step.run("embed-normalized-headline", async () => {
          return embedTextForClustering(headlineText);
        });

        await step.run("persist-normalized-headline-embedding", async () => {
          const embedding = stringifyVector(tweetEmbedding);
          if (!embedding) {
            throw new Error("Embedding generation returned an empty vector");
          }

          await TweetsModel.updateNormalizedHeadlineEmbedding({
            tweetDbId: tweet.id,
            embedding,
          });
        });
      }

      if (!tweetEmbedding) {
        const summary = {
          status: "ok",
          processed: 0,
          skipped: 1,
          reason: "empty_normalized_content",
          tweet_id: tweet.tweet_id,
        };

        await step.run("record-success-empty-content", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-assign",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const cutoff = new Date(
        Date.now() - CLUSTER_LOOKBACK_HOURS * 60 * 60 * 1000
      ).toISOString();

      const candidates = await step.run("load-cluster-candidates", async () => {
        const { data, error } = await supabase
          .from("x_news_clusters")
          .select("id,token_set,last_seen_at,tweet_count,centroid_embedding")
          .is("merged_into_cluster_id", null)
          .gte("last_seen_at", cutoff)
          .order("last_seen_at", { ascending: false })
          .limit(CLUSTER_MAX_CANDIDATES);

        if (error) {
          throw new Error(`Cluster candidate lookup failed: ${error.message}`);
        }

        return (data ?? []) as ClusterRow[];
      });

      const eventTimestamp = pickEventTimestamp(tweet.tweet_time);
      const best = findBestMatch({ tokens, tweetEmbedding, clusters: candidates });
      const shouldAttach = best !== null && best.similarity >= CLUSTER_ASSIGN_THRESHOLD;

      let clusterId: number;
      let similarity: number | null = null;
      let lexicalSimilarity: number | null = null;
      let action: "created_cluster" | "attached_to_cluster";

      if (shouldAttach) {
        clusterId = best.cluster.id;
        similarity = best.similarity;
        lexicalSimilarity = best.lexicalSimilarity;
        action = "attached_to_cluster";

        await step.run("assign-to-existing-cluster", async () => {
          await assignTweetToCluster(tweet.id, clusterId, similarity);

          const mergedTokenSet = mergeTokenSets(best.clusterTokens, tokens);
          const currentCount =
            typeof best.cluster.tweet_count === "number" && best.cluster.tweet_count > 0
              ? best.cluster.tweet_count
              : 0;
          const mergedCentroid = weightedAverageVector({
            base: best.clusterEmbedding,
            baseWeight: currentCount,
            incoming: tweetEmbedding,
            incomingWeight: 1,
          });

          const { error } = await supabase
            .from("x_news_clusters")
            .update({
              token_set: mergedTokenSet,
              centroid_embedding: stringifyVector(mergedCentroid),
              last_seen_at: chooseLastSeen(best.cluster.last_seen_at, eventTimestamp),
              updated_at: new Date().toISOString(),
            })
            .eq("id", clusterId)
            .is("merged_into_cluster_id", null);

          if (error) {
            throw new Error(`Cluster update failed: ${error.message}`);
          }
        });

        await step.sendEvent("emit-cluster-updated", {
          name: "x-news/cluster.updated",
          data: { clusterId },
        });
      } else {
        action = "created_cluster";

        clusterId = await step.run("create-new-cluster", async () => {
          const { data, error } = await supabase
            .from("x_news_clusters")
            .insert({
              first_seen_at: eventTimestamp,
              last_seen_at: eventTimestamp,
              normalized_headline: tweet.normalized_headline,
              normalized_facts: facts,
              canonical_text: canonicalText,
              token_set: tokens,
              centroid_embedding: stringifyVector(tweetEmbedding),
              updated_at: new Date().toISOString(),
            })
            .select("id")
            .single();

          if (error || !data?.id) {
            throw new Error(
              `New cluster insert failed: ${error?.message ?? "missing cluster id"}`
            );
          }

          await assignTweetToCluster(tweet.id, data.id, null);
          return data.id;
        });

        await step.sendEvent("emit-cluster-created", {
          name: "x-news/cluster.created",
          data: { clusterId },
        });
      }

      const stats = await step.run("recompute-cluster-stats", async () => {
        return recomputeClusterStats(clusterId);
      });

      const summary = {
        status: "ok",
        processed: 1,
        tweet_id: tweet.tweet_id,
        cluster_id: clusterId,
        action,
        similarity,
        threshold: CLUSTER_ASSIGN_THRESHOLD,
        lexical_similarity: lexicalSimilarity,
        tokens: tokens.length,
        scanned_clusters: candidates.length,
        tweet_count: stats.tweetCount,
        unique_user_count: stats.uniqueUserCount,
        is_story_candidate: stats.isStoryCandidate,
        embedding_model: getEmbeddingModel(),
        used_raw_fallback: usedRawFallback,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-assign",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-assign",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
