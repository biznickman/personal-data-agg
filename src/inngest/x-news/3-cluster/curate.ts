import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { tokenizeCanonicalText } from "./tokenize";
import { recomputeClusterStats } from "./sync";

const LOOKBACK_HOURS = 48;
const MAX_CLUSTERS = 500;
const MIN_SHARED_TOKENS = 2;
const BATCH_CHAR_LIMIT = 12_000;
const DB_CHUNK = 200;
const LLM_DIRECT_THRESHOLD = 100;

// ── LLM provider helpers (mirrored from review.ts) ──────────────────────────

type NormalizerProvider = "openrouter" | "portkey";

interface NormalizerConfig {
  provider: NormalizerProvider;
  model: string;
}

interface ChatChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

interface ChatCompletionResponse {
  choices?: ChatChoice[];
}

function getNormalizerConfig(): NormalizerConfig {
  const provider = (
    process.env.X_NEWS_NORMALIZER_PROVIDER ?? "openrouter"
  ).toLowerCase();

  if (provider !== "openrouter" && provider !== "portkey") {
    throw new Error(
      `Unsupported X_NEWS_NORMALIZER_PROVIDER: ${provider}. Use "openrouter" or "portkey".`
    );
  }

  const DEFAULT_MODEL =
    provider === "openrouter"
      ? "anthropic/claude-3.5-haiku"
      : "anthropic/claude-3-5-haiku-latest";
  const model = process.env.X_NEWS_NORMALIZER_MODEL ?? DEFAULT_MODEL;

  return { provider: provider as NormalizerProvider, model };
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const content = response.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n")
      .trim();
  }
  throw new Error("LLM response did not include message content");
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return JSON.parse(trimmed);
  }
  const fenced = trimmed.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1]);
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }
  throw new Error("Could not find JSON object in LLM response");
}

async function callOpenRouter(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "ingestion-engine",
    },
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      max_tokens: params.maxTokens ?? 1000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${text}`);
  }

  return extractMessageContent((await response.json()) as ChatCompletionResponse);
}

async function callPortkey(params: {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
}): Promise<string> {
  const apiKey = process.env.PORTKEY_API_KEY;
  if (!apiKey) throw new Error("Missing PORTKEY_API_KEY");

  const baseUrl = (
    process.env.PORTKEY_BASE_URL ?? "https://api.portkey.ai/v1"
  ).replace(/\/$/, "");
  const config = process.env.PORTKEY_CONFIG;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-portkey-api-key": apiKey,
  };
  if (config) headers["x-portkey-config"] = config;

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      max_tokens: params.maxTokens ?? 1000,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: params.systemPrompt },
        { role: "user", content: params.userPrompt },
      ],
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Portkey ${response.status}: ${text}`);
  }

  return extractMessageContent((await response.json()) as ChatCompletionResponse);
}

// ── Types ───────────────────────────────────────────────────────────────────

type ActiveCluster = {
  id: number;
  normalized_headline: string | null;
  tweet_count: number;
  first_seen_at: string | null;
};

type ClusterFact = {
  cluster_id: number;
  normalized_facts: unknown;
};

type CandidateGroup = {
  clusterIds: number[];
};

type MergeGroup = {
  cluster_ids: number[];
  reason: string;
};

// ── Pre-filter: token overlap → connected components ────────────────────────

function buildCandidateGroups(
  clusters: ActiveCluster[]
): CandidateGroup[] {
  // Tokenize each cluster headline
  const clusterTokens = new Map<number, string[]>();
  for (const c of clusters) {
    if (!c.normalized_headline) continue;
    const tokens = tokenizeCanonicalText(c.normalized_headline);
    if (tokens.length > 0) clusterTokens.set(c.id, tokens);
  }

  // Build inverted index: token → cluster IDs
  const invertedIndex = new Map<string, number[]>();
  for (const [clusterId, tokens] of clusterTokens) {
    for (const token of tokens) {
      let list = invertedIndex.get(token);
      if (!list) {
        list = [];
        invertedIndex.set(token, list);
      }
      list.push(clusterId);
    }
  }

  // Find pairs sharing >= MIN_SHARED_TOKENS tokens
  const pairOverlap = new Map<string, number>();
  for (const [, clusterIds] of invertedIndex) {
    if (clusterIds.length < 2 || clusterIds.length > 50) continue;
    for (let i = 0; i < clusterIds.length; i++) {
      for (let j = i + 1; j < clusterIds.length; j++) {
        const key =
          clusterIds[i] < clusterIds[j]
            ? `${clusterIds[i]}:${clusterIds[j]}`
            : `${clusterIds[j]}:${clusterIds[i]}`;
        pairOverlap.set(key, (pairOverlap.get(key) ?? 0) + 1);
      }
    }
  }

  // Build adjacency list from qualifying pairs
  const adjacency = new Map<number, Set<number>>();
  for (const [key, count] of pairOverlap) {
    if (count < MIN_SHARED_TOKENS) continue;
    const [a, b] = key.split(":").map(Number);
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }

  // BFS to find connected components
  const visited = new Set<number>();
  const groups: CandidateGroup[] = [];

  for (const nodeId of adjacency.keys()) {
    if (visited.has(nodeId)) continue;
    const component: number[] = [];
    const queue = [nodeId];
    visited.add(nodeId);

    while (queue.length > 0) {
      const current = queue.shift()!;
      component.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    if (component.length >= 2) {
      groups.push({ clusterIds: component.sort((a, b) => a - b) });
    }
  }

  return groups;
}

// ── Batch groups for LLM ────────────────────────────────────────────────────

function batchGroups(
  groups: CandidateGroup[],
  clusterMap: Map<number, ActiveCluster>,
  clusterFacts: Map<number, string[]>
): CandidateGroup[][] {
  const batches: CandidateGroup[][] = [];
  let currentBatch: CandidateGroup[] = [];
  let currentChars = 0;

  for (const group of groups) {
    let groupChars = 0;
    for (const id of group.clusterIds) {
      const c = clusterMap.get(id);
      groupChars += (c?.normalized_headline ?? "").length + 20;
      const facts = clusterFacts.get(id) ?? [];
      for (const f of facts) groupChars += f.length + 5;
    }

    if (currentChars > 0 && currentChars + groupChars > BATCH_CHAR_LIMIT) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(group);
    currentChars += groupChars;
  }

  if (currentBatch.length > 0) batches.push(currentBatch);
  return batches;
}

// ── LLM call ────────────────────────────────────────────────────────────────

const CURATION_SYSTEM_PROMPT = `You are a news cluster deduplication assistant. You will receive groups of news cluster headlines that may be duplicates.

Your job: decide which clusters within each group should be MERGED because they cover the EXACT same news event.

Rules:
- Only merge clusters about the EXACT same specific news event
- Do NOT merge merely related stories (e.g. "Bitcoin drops 5%" and "Fed raises rates" are different stories)
- Different countries doing similar things = different stories (e.g. "Japan bans X" ≠ "EU bans X")
- Different time periods = different stories (e.g. "Q1 earnings" ≠ "Q2 earnings")
- If a group has no true duplicates, omit it from your response
- Be conservative — when in doubt, do NOT merge

Respond with a JSON object:
{
  "merge_groups": [
    { "cluster_ids": [1, 2, 3], "reason": "All cover the same event: ..." }
  ]
}

If no merges are needed, respond: { "merge_groups": [] }`;

function buildUserPrompt(
  groups: CandidateGroup[],
  clusterMap: Map<number, ActiveCluster>,
  clusterFacts: Map<number, string[]>
): string {
  const parts: string[] = [];

  for (let gi = 0; gi < groups.length; gi++) {
    const group = groups[gi];
    parts.push(`--- Group ${gi + 1} ---`);
    for (const id of group.clusterIds) {
      const c = clusterMap.get(id);
      if (!c) continue;
      const facts = clusterFacts.get(id) ?? [];
      const factsStr =
        facts.length > 0 ? `\n  Facts: ${facts.slice(0, 3).join("; ")}` : "";
      parts.push(
        `  [${id}] (${c.tweet_count} tweets) ${c.normalized_headline ?? "(no headline)"}${factsStr}`
      );
    }
  }

  return parts.join("\n");
}

async function callCurationLlm(
  groups: CandidateGroup[],
  clusterMap: Map<number, ActiveCluster>,
  clusterFacts: Map<number, string[]>
): Promise<MergeGroup[]> {
  const userPrompt = buildUserPrompt(groups, clusterMap, clusterFacts);
  const config = getNormalizerConfig();

  const rawContent =
    config.provider === "openrouter"
      ? await callOpenRouter({
          model: config.model,
          systemPrompt: CURATION_SYSTEM_PROMPT,
          userPrompt,
        })
      : await callPortkey({
          model: config.model,
          systemPrompt: CURATION_SYSTEM_PROMPT,
          userPrompt,
        });

  try {
    const parsed = extractJsonObject(rawContent) as {
      merge_groups?: unknown;
    };
    if (!Array.isArray(parsed.merge_groups)) return [];
    return parsed.merge_groups.filter(
      (g: unknown): g is MergeGroup =>
        typeof g === "object" &&
        g !== null &&
        Array.isArray((g as MergeGroup).cluster_ids) &&
        (g as MergeGroup).cluster_ids.every(
          (id: unknown) => typeof id === "number"
        )
    );
  } catch {
    console.warn("Failed to parse LLM curation response:", rawContent);
    return [];
  }
}

// ── Inngest function ────────────────────────────────────────────────────────

export const xNewsClusterCurate = inngest.createFunction(
  {
    id: "x-news-cluster-curate",
    retries: 1,
    concurrency: 1,
    timeouts: {
      finish: "5m",
    },
  },
  { cron: "*/20 * * * *" },
  async ({ step }) => {
    try {
      const since = new Date(
        Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000
      ).toISOString();

      // ── Step 1: Load active clusters ────────────────────────────────────────
      const clusters = await step.run("load-active-clusters", async () => {
        const { data, error } = await supabase
          .from("x_news_clusters")
          .select("id,normalized_headline,tweet_count,first_seen_at")
          .eq("is_active", true)
          .is("merged_into_cluster_id", null)
          .gte("last_seen_at", since)
          .order("tweet_count", { ascending: false })
          .limit(MAX_CLUSTERS);

        if (error) throw new Error(`Load clusters failed: ${error.message}`);
        return (data ?? []) as ActiveCluster[];
      });

      if (clusters.length < 2) {
        const summary = { status: "ok", clusters: clusters.length, candidate_groups: 0, merges: 0 };
        await step.run("record-empty-run", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-curate",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      const clusterMap = new Map(clusters.map((c) => [c.id, c]));

      // ── Step 2: Build candidate groups ────────────────────────────────────────
      // For small cluster counts, skip the token pre-filter and let the LLM
      // evaluate all clusters directly. Fall back to token overlap for large sets.
      const candidateGroups = await step.run("build-candidate-groups", async () => {
        if (clusters.length <= LLM_DIRECT_THRESHOLD) {
          const ids = clusters
            .filter((c) => c.normalized_headline?.trim())
            .map((c) => c.id);
          return ids.length >= 2 ? [{ clusterIds: ids }] : [];
        }
        return buildCandidateGroups(clusters);
      });

      if (candidateGroups.length === 0) {
        const summary = { status: "ok", clusters: clusters.length, candidate_groups: 0, merges: 0 };
        await step.run("record-no-candidates", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-curate",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      // ── Step 3: Load facts for candidate clusters ───────────────────────────
      const clusterFacts = await step.run("load-cluster-facts", async () => {
        const candidateClusterIds = [
          ...new Set(candidateGroups.flatMap((g) => g.clusterIds)),
        ];
        const factsMap = new Map<number, string[]>();

        for (let i = 0; i < candidateClusterIds.length; i += DB_CHUNK) {
          const chunk = candidateClusterIds.slice(i, i + DB_CHUNK);
          const { data, error } = await supabase
            .from("x_news_clusters")
            .select("id,normalized_facts")
            .in("id", chunk);
          if (error) throw new Error(`Load facts failed: ${error.message}`);
          for (const row of (data ?? []) as Array<{ id: number; normalized_facts: unknown }>) {
            const facts = Array.isArray(row.normalized_facts)
              ? (row.normalized_facts as string[]).filter(
                  (f): f is string => typeof f === "string"
                )
              : [];
            if (facts.length > 0) factsMap.set(row.id, facts);
          }
        }

        // Convert to serializable format for step output
        return Object.fromEntries(factsMap);
      });

      const factsMapRestored = new Map<number, string[]>(
        Object.entries(clusterFacts).map(([k, v]) => [Number(k), v])
      );

      // ── Step 4: LLM calls (batched) ────────────────────────────────────────
      const batches = batchGroups(candidateGroups, clusterMap, factsMapRestored);
      const allMergeGroups: MergeGroup[] = [];

      for (let bi = 0; bi < batches.length; bi++) {
        const batch = batches[bi];
        const mergeGroups = await step.run(`llm-curation-batch-${bi}`, async () => {
          return callCurationLlm(batch, clusterMap, factsMapRestored);
        });
        allMergeGroups.push(...mergeGroups);
      }

      if (allMergeGroups.length === 0) {
        const summary = {
          status: "ok",
          clusters: clusters.length,
          candidate_groups: candidateGroups.length,
          llm_batches: batches.length,
          merges: 0,
        };
        await step.run("record-no-merges", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-curate",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      // ── Step 5: Execute merges ──────────────────────────────────────────────
      const mergeResults = await step.run("execute-merges", async () => {
        const now = new Date().toISOString();
        let totalMerged = 0;
        const clusterIdSet = new Set(clusters.map((c) => c.id));

        for (const group of allMergeGroups) {
          // Filter to valid, known cluster IDs
          const validIds = group.cluster_ids.filter((id) => clusterIdSet.has(id));
          if (validIds.length < 2) continue;

          // Re-fetch to confirm none have been merged already
          const { data: freshRows, error: freshError } = await supabase
            .from("x_news_clusters")
            .select("id,tweet_count,first_seen_at")
            .in("id", validIds)
            .is("merged_into_cluster_id", null);

          if (freshError || !freshRows || freshRows.length < 2) continue;

          const freshClusters = freshRows as Array<{
            id: number;
            tweet_count: number;
            first_seen_at: string | null;
          }>;

          // Pick target: largest tweet_count, ties → older first_seen_at, ties → lower ID
          freshClusters.sort((a, b) => {
            if (b.tweet_count !== a.tweet_count) return b.tweet_count - a.tweet_count;
            const aTime = a.first_seen_at ? new Date(a.first_seen_at).getTime() : Infinity;
            const bTime = b.first_seen_at ? new Date(b.first_seen_at).getTime() : Infinity;
            if (aTime !== bTime) return aTime - bTime;
            return a.id - b.id;
          });

          const targetId = freshClusters[0].id;
          const sourceIds = freshClusters.slice(1).map((c) => c.id);

          for (const sourceId of sourceIds) {
            // Guard: re-check source hasn't been merged
            const { data: sourceCheck } = await supabase
              .from("x_news_clusters")
              .select("id")
              .eq("id", sourceId)
              .is("merged_into_cluster_id", null)
              .maybeSingle();

            if (!sourceCheck) continue;

            // Reassign tweets
            const { error: reassignError } = await supabase
              .from("x_news_cluster_tweets")
              .update({ cluster_id: targetId })
              .eq("cluster_id", sourceId);

            if (reassignError) {
              console.error(
                `Failed to reassign tweets from ${sourceId} to ${targetId}:`,
                reassignError.message
              );
              continue;
            }

            // Mark source as merged
            const { error: mergeError } = await supabase
              .from("x_news_clusters")
              .update({
                merged_into_cluster_id: targetId,
                is_active: false,
              })
              .eq("id", sourceId);

            if (mergeError) {
              console.error(
                `Failed to mark cluster ${sourceId} as merged:`,
                mergeError.message
              );
              continue;
            }

            // Record merge
            await supabase.from("x_news_cluster_merges").insert({
              source_cluster_id: sourceId,
              target_cluster_id: targetId,
              reason: "llm_curation_duplicate",
              merged_at: now,
            });

            totalMerged++;
          }

          // Recompute stats for the target cluster
          await recomputeClusterStats(targetId, now);
        }

        return { totalMerged };
      });

      // ── Step 6: Record run ──────────────────────────────────────────────────
      const summary = {
        status: "ok",
        clusters: clusters.length,
        candidate_groups: candidateGroups.length,
        llm_batches: batches.length,
        merge_groups_from_llm: allMergeGroups.length,
        merges: mergeResults.totalMerged,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-curate",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-curate",
          state: "error",
          errorMessage: message,
        });
      });
      throw error;
    }
  }
);
