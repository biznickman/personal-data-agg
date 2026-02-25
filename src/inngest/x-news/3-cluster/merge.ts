import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { recomputeClusterStats } from "./cluster-db";
import { jaccardSimilarity, mergeTokenSets, parseTokenSet } from "./tokenize";
import {
  cosineSimilarity,
  parseVector,
  stringifyVector,
  weightedAverageVector,
} from "./vector";

type ClusterRow = {
  id: number;
  token_set: unknown;
  first_seen_at: string | null;
  last_seen_at: string | null;
  tweet_count: number | null;
  centroid_embedding: unknown;
};

interface MergeCandidate {
  sourceId: number;
  targetId: number;
  similarity: number;
}

function parsePositiveNumber(input: string | undefined, fallback: number): number {
  if (!input) return fallback;
  const parsed = Number.parseFloat(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const CLUSTER_MERGE_THRESHOLD = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_MERGE_THRESHOLD_EMBEDDING,
  0.82
);
const CLUSTER_MERGE_MIN_LEXICAL_OVERLAP = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_MERGE_MIN_LEXICAL_OVERLAP_EMBEDDING,
  0.08
);
const CLUSTER_LOOKBACK_HOURS = parsePositiveNumber(
  process.env.X_NEWS_CLUSTER_LOOKBACK_HOURS,
  48
);
const CLUSTER_MAX_CANDIDATES = Math.floor(
  parsePositiveNumber(process.env.X_NEWS_CLUSTER_MAX_CANDIDATES, 200)
);

function toMs(value: string | null): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function pickLatestTimestamp(a: string | null, b: string | null): string | null {
  const aMs = toMs(a);
  const bMs = toMs(b);
  if (Number.isNaN(aMs) && Number.isNaN(bMs)) return a ?? b;
  if (Number.isNaN(aMs)) return b;
  if (Number.isNaN(bMs)) return a;
  return aMs >= bMs ? a : b;
}

function chooseMergeDirection(a: ClusterRow, b: ClusterRow): {
  sourceId: number;
  targetId: number;
} {
  const aCount = a.tweet_count ?? 0;
  const bCount = b.tweet_count ?? 0;

  if (aCount !== bCount) {
    return aCount > bCount
      ? { sourceId: b.id, targetId: a.id }
      : { sourceId: a.id, targetId: b.id };
  }

  const aFirst = toMs(a.first_seen_at);
  const bFirst = toMs(b.first_seen_at);

  if (!Number.isNaN(aFirst) && !Number.isNaN(bFirst) && aFirst !== bFirst) {
    return aFirst <= bFirst
      ? { sourceId: b.id, targetId: a.id }
      : { sourceId: a.id, targetId: b.id };
  }

  return a.id < b.id
    ? { sourceId: b.id, targetId: a.id }
    : { sourceId: a.id, targetId: b.id };
}

function getSimilarity(
  source: ClusterRow,
  other: ClusterRow
): { similarity: number; threshold: number } | null {
  // Lexical pre-filter: skip embedding comparison if there is no token overlap
  const sourceTokens = parseTokenSet(source.token_set);
  const otherTokens = parseTokenSet(other.token_set);
  if (sourceTokens.length > 0 && otherTokens.length > 0) {
    const lexicalSimilarity = jaccardSimilarity(sourceTokens, otherTokens);
    if (lexicalSimilarity < CLUSTER_MERGE_MIN_LEXICAL_OVERLAP) {
      return null;
    }
  }

  const sourceEmbedding = parseVector(source.centroid_embedding);
  const otherEmbedding = parseVector(other.centroid_embedding);
  if (!sourceEmbedding || !otherEmbedding) return null;

  return {
    similarity: cosineSimilarity(sourceEmbedding, otherEmbedding),
    threshold: CLUSTER_MERGE_THRESHOLD,
  };
}

function pickBestMergeForSource(
  source: ClusterRow,
  clusters: ClusterRow[],
  mergedIds: Set<number>
): MergeCandidate | null {
  let best: MergeCandidate | null = null;

  for (const other of clusters) {
    if (other.id === source.id) continue;
    if (mergedIds.has(other.id)) continue;

    const similarityResult = getSimilarity(source, other);
    if (!similarityResult) continue;
    if (similarityResult.similarity < similarityResult.threshold) continue;

    const direction = chooseMergeDirection(source, other);
    if (direction.sourceId !== source.id) continue;

    if (!best || similarityResult.similarity > best.similarity) {
      best = {
        sourceId: direction.sourceId,
        targetId: direction.targetId,
        similarity: similarityResult.similarity,
      };
    }
  }

  return best;
}

async function mergeCluster(params: {
  sourceId: number;
  targetId: number;
  similarity: number;
}): Promise<void> {
  const { sourceId, targetId, similarity } = params;

  const { data: tokenRows, error: tokenError } = await supabase
    .from("x_news_clusters")
    .select("id,token_set,last_seen_at,tweet_count,centroid_embedding")
    .in("id", [sourceId, targetId]);

  if (tokenError) {
    throw new Error(`Cluster token lookup failed: ${tokenError.message}`);
  }

  const rows = (tokenRows ?? []) as Array<{
    id: number;
    token_set: unknown;
    last_seen_at: string | null;
    tweet_count: number | null;
    centroid_embedding: unknown;
  }>;

  const source = rows.find((row) => row.id === sourceId);
  const target = rows.find((row) => row.id === targetId);
  if (!source || !target) {
    throw new Error("Source or target cluster missing before merge");
  }

  const mergedTokens = mergeTokenSets(parseTokenSet(target.token_set), parseTokenSet(source.token_set));
  const mergedLastSeen = pickLatestTimestamp(source.last_seen_at, target.last_seen_at);

  const sourceCount = typeof source.tweet_count === "number" && source.tweet_count > 0 ? source.tweet_count : 0;
  const targetCount = typeof target.tweet_count === "number" && target.tweet_count > 0 ? target.tweet_count : 0;
  const mergedCentroid = weightedAverageVector({
    base: parseVector(target.centroid_embedding),
    baseWeight: targetCount,
    incoming: parseVector(source.centroid_embedding),
    incomingWeight: sourceCount || 1,
  });

  const { error: moveError } = await supabase
    .from("x_news_cluster_tweets")
    .update({ cluster_id: targetId })
    .eq("cluster_id", sourceId);

  if (moveError) {
    throw new Error(`Cluster tweet reassignment failed: ${moveError.message}`);
  }

  const { error: targetUpdateError } = await supabase
    .from("x_news_clusters")
    .update({
      token_set: mergedTokens,
      centroid_embedding: stringifyVector(mergedCentroid),
      last_seen_at: mergedLastSeen ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", targetId)
    .is("merged_into_cluster_id", null);

  if (targetUpdateError) {
    throw new Error(`Target cluster update failed: ${targetUpdateError.message}`);
  }

  const { error: sourceUpdateError } = await supabase
    .from("x_news_clusters")
    .update({
      merged_into_cluster_id: targetId,
      is_story_candidate: false,
      updated_at: new Date().toISOString(),
    })
    .eq("id", sourceId)
    .is("merged_into_cluster_id", null);

  if (sourceUpdateError) {
    throw new Error(`Source cluster merge update failed: ${sourceUpdateError.message}`);
  }

  const { error: historyError } = await supabase.from("x_news_cluster_merges").insert({
    source_cluster_id: sourceId,
    target_cluster_id: targetId,
    similarity_score: similarity,
    reason: "embedding_centroid_similarity",
  });

  if (historyError) {
    throw new Error(`Cluster merge history insert failed: ${historyError.message}`);
  }

  await recomputeClusterStats(targetId);
}

/**
 * Periodic duplicate-cluster merge using embedding cosine similarity.
 * A lexical pre-filter guards against unnecessary embedding comparisons.
 */
export const xNewsClusterMerge = inngest.createFunction(
  {
    id: "x-news-cluster-merge",
    retries: 1,
    concurrency: 1,
    timeouts: {
      finish: "4m",
    },
  },
  { cron: "*/2 * * * *" },
  async ({ step }) => {
    try {
      const cutoff = new Date(
        Date.now() - CLUSTER_LOOKBACK_HOURS * 60 * 60 * 1000
      ).toISOString();

      const clusters = await step.run("load-clusters", async () => {
        const { data, error } = await supabase
          .from("x_news_clusters")
          .select("id,token_set,first_seen_at,last_seen_at,tweet_count,centroid_embedding")
          .is("merged_into_cluster_id", null)
          .gte("last_seen_at", cutoff)
          .order("last_seen_at", { ascending: false })
          .limit(CLUSTER_MAX_CANDIDATES);

        if (error) {
          throw new Error(`Cluster load failed: ${error.message}`);
        }

        return (data ?? []) as ClusterRow[];
      });

      if (clusters.length < 2) {
        const summary = {
          status: "ok",
          scanned_clusters: clusters.length,
          merges: 0,
        };

        await step.run("record-success-empty", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-merge",
            state: "ok",
            details: summary,
          });
        });

        return summary;
      }

      const mergedIds = new Set<number>();
      const touchedTargets = new Set<number>();
      let mergeCount = 0;

      await step.run("merge-duplicates", async () => {
        for (const source of clusters) {
          if (mergedIds.has(source.id)) continue;

          const candidate = pickBestMergeForSource(source, clusters, mergedIds);
          if (!candidate) continue;

          await mergeCluster({
            sourceId: candidate.sourceId,
            targetId: candidate.targetId,
            similarity: candidate.similarity,
          });
          mergeCount += 1;

          mergedIds.add(candidate.sourceId);
          touchedTargets.add(candidate.targetId);
        }
      });

      if (touchedTargets.size > 0) {
        await step.sendEvent(
          "emit-cluster-updated-events",
          [...touchedTargets].map((clusterId) => ({
            name: "x-news/cluster.updated",
            data: { clusterId },
          }))
        );
      }

      const summary = {
        status: "ok",
        scanned_clusters: clusters.length,
        merges: mergeCount,
        updated_targets: touchedTargets.size,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-merge",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";

      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-merge",
          state: "error",
          errorMessage: message,
        });
      });

      throw error;
    }
  }
);
