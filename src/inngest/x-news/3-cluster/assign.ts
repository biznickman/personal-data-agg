import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { recomputeClusterStats } from "./cluster-db";
import {
  buildCanonicalText,
  getClusterTextMode,
  jaccardSimilarity,
  mergeTokenSets,
  parseNormalizedFacts,
  parseTokenSet,
  tokenizeCanonicalText,
} from "./tokenize";
import {
  embedTextForClustering,
  getClusterSimilarityMode,
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

type TweetRow = {
  id: number;
  tweet_id: string;
  username: string | null;
  tweet_time: string | null;
  normalized_headline: string | null;
  normalized_facts: unknown;
  normalized_headline_embedding: unknown;
};

type ClusterRow = {
  id: number;
  token_set: unknown;
  last_seen_at: string | null;
  tweet_count: number | null;
  centroid_embedding: unknown;
};

type SimilarityModeUsed = "embedding" | "lexical";

interface BestMatch {
  cluster: ClusterRow;
  similarity: number;
  clusterTokens: string[];
  clusterEmbedding: number[] | null;
  similarityMode: SimilarityModeUsed;
  lexicalSimilarity: number | null;
}

function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CLUSTER_SIMILARITY_MODE = getClusterSimilarityMode(
  process.env.X_NEWS_CLUSTER_SIMILARITY_MODE
);
const CLUSTER_ASSIGN_THRESHOLD_LEXICAL = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_ASSIGN_THRESHOLD,
  0.3
);
const CLUSTER_ASSIGN_THRESHOLD_EMBEDDING = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_ASSIGN_THRESHOLD_EMBEDDING,
  0.76
);
const CLUSTER_ASSIGN_MIN_LEXICAL_OVERLAP_EMBEDDING = parsePositiveNumber(
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
const CLUSTER_TEXT_MODE = getClusterTextMode(process.env.X_NEWS_CLUSTER_TEXT_MODE);

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
  tweetEmbedding: number[] | null;
  clusters: ClusterRow[];
}): BestMatch | null {
  const { tokens, tweetEmbedding, clusters } = params;

  if (CLUSTER_SIMILARITY_MODE === "embedding" && tweetEmbedding) {
    let bestEmbedding: BestMatch | null = null;

    for (const cluster of clusters) {
      const clusterEmbedding = parseVector(cluster.centroid_embedding);
      if (!clusterEmbedding) continue;

      const clusterTokens = parseTokenSet(cluster.token_set);
      const lexicalSimilarity =
        tokens.length > 0 && clusterTokens.length > 0
          ? jaccardSimilarity(tokens, clusterTokens)
          : 0;
      if (
        tokens.length > 0 &&
        lexicalSimilarity < CLUSTER_ASSIGN_MIN_LEXICAL_OVERLAP_EMBEDDING
      ) {
        continue;
      }

      const similarity = cosineSimilarity(tweetEmbedding, clusterEmbedding);
      if (!bestEmbedding || similarity > bestEmbedding.similarity) {
        bestEmbedding = {
          cluster,
          similarity,
          clusterTokens,
          clusterEmbedding,
          similarityMode: "embedding",
          lexicalSimilarity,
        };
      }
    }

    if (bestEmbedding) return bestEmbedding;
  }

  if (tokens.length === 0) return null;

  let bestLexical: BestMatch | null = null;
  for (const cluster of clusters) {
    const clusterTokens = parseTokenSet(cluster.token_set);
    if (clusterTokens.length === 0) continue;

    const similarity = jaccardSimilarity(tokens, clusterTokens);
    if (!bestLexical || similarity > bestLexical.similarity) {
      bestLexical = {
        cluster,
        similarity,
        clusterTokens,
        clusterEmbedding: parseVector(cluster.centroid_embedding),
        similarityMode: "lexical",
        lexicalSimilarity: similarity,
      };
    }
  }

  return bestLexical;
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
 * Assigns normalized tweets to existing or new clusters.
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
        const { data, error } = await supabase
          .from("tweets")
          .select(
            "id,tweet_id,username,tweet_time,normalized_headline,normalized_facts,normalized_headline_embedding"
          )
          .eq("tweet_id", tweetId)
          .maybeSingle();

        if (error) {
          throw new Error(`Tweet lookup failed: ${error.message}`);
        }

        return (data ?? null) as TweetRow | null;
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
      const canonicalText = buildCanonicalText(
        tweet.normalized_headline,
        facts,
        CLUSTER_TEXT_MODE
      );
      const tokens = tokenizeCanonicalText(canonicalText);

      let tweetEmbedding = parseVector(tweet.normalized_headline_embedding);
      const shouldEmbedTweet = CLUSTER_SIMILARITY_MODE === "embedding" && !tweetEmbedding;
      if (shouldEmbedTweet) {
        const headlineText = headlineForEmbedding(tweet.normalized_headline);
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
          const { error } = await supabase
            .from("tweets")
            .update({
              normalized_headline_embedding: stringifyVector(tweetEmbedding),
            })
            .eq("id", tweet.id);

          if (error) {
            throw new Error(`Tweet embedding update failed: ${error.message}`);
          }
        });
      }

      if (tokens.length === 0 && !tweetEmbedding) {
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

      const threshold =
        best?.similarityMode === "embedding"
          ? CLUSTER_ASSIGN_THRESHOLD_EMBEDDING
          : CLUSTER_ASSIGN_THRESHOLD_LEXICAL;
      const shouldAttach = best !== null && best.similarity >= threshold;

      let clusterId: number;
      let similarity: number | null = null;
      let lexicalSimilarity: number | null = null;
      let similarityModeUsed: SimilarityModeUsed | null = null;
      let action: "created_cluster" | "attached_to_cluster";

      if (shouldAttach) {
        clusterId = best.cluster.id;
        similarity = best.similarity;
        lexicalSimilarity = best.lexicalSimilarity;
        similarityModeUsed = best.similarityMode;
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
        similarity_mode_used: similarityModeUsed,
        threshold_used: threshold,
        lexical_similarity: lexicalSimilarity,
        tokens: tokens.length,
        scanned_clusters: candidates.length,
        tweet_count: stats.tweetCount,
        unique_user_count: stats.uniqueUserCount,
        is_story_candidate: stats.isStoryCandidate,
        text_mode: CLUSTER_TEXT_MODE,
        cluster_similarity_mode: CLUSTER_SIMILARITY_MODE,
        embedding_model:
          CLUSTER_SIMILARITY_MODE === "embedding" ? getEmbeddingModel() : null,
        tweet_embedding_generated: shouldEmbedTweet,
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
