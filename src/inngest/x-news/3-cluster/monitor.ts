import { inngest } from "../../client";
import { supabase } from "@/lib/supabase";
import { recordFunctionRun } from "../../run-status";
import { matchesSpamPattern, checkSpamLlm } from "./qualify";

const DB_CHUNK = 200;
const MAX_CLUSTERS = 500;

// ── Inngest function ────────────────────────────────────────────────────────

export const xNewsClusterMonitor = inngest.createFunction(
  {
    id: "x-news-cluster-monitor",
    retries: 1,
    concurrency: 1,
    timeouts: {
      finish: "5m",
    },
  },
  { cron: "*/20 * * * *" },
  async ({ step }) => {
    try {
      // ── Step 1: Load active promoted clusters ──────────────────────────────
      const clusters = await step.run("load-promoted-clusters", async () => {
        const { data, error } = await supabase
          .from("x_news_clusters")
          .select("id,normalized_headline")
          .eq("is_active", true)
          .eq("is_story_candidate", true)
          .not("promoted_at", "is", null)
          .is("merged_into_cluster_id", null)
          .order("promoted_at", { ascending: false })
          .limit(MAX_CLUSTERS);

        if (error) throw new Error(`Load clusters failed: ${error.message}`);
        return (data ?? []) as Array<{ id: number; normalized_headline: string | null }>;
      });

      if (clusters.length === 0) {
        const summary = { status: "ok", clusters: 0, deactivated: 0 };
        await step.run("record-empty-run", async () => {
          await recordFunctionRun({
            functionId: "x-news-cluster-monitor",
            state: "ok",
            details: summary,
          });
        });
        return summary;
      }

      // ── Step 2: Check each cluster for spam ────────────────────────────────
      const spamClusterIds = await step.run("check-spam-batch", async () => {
        const spamIds: number[] = [];

        for (const cluster of clusters) {
          const headline = cluster.normalized_headline?.trim();
          if (!headline) continue;

          // Tier 1: Deterministic pattern check
          if (matchesSpamPattern(headline)) {
            spamIds.push(cluster.id);
            continue;
          }

          // Tier 2: LLM check
          const result = await checkSpamLlm(headline);
          if (result.verdict === "spam") {
            spamIds.push(cluster.id);
          }
        }

        return spamIds;
      });

      // ── Step 3: Deactivate spam clusters ───────────────────────────────────
      const deactivated = await step.run("deactivate-spam", async () => {
        if (spamClusterIds.length === 0) return 0;

        let count = 0;
        for (let i = 0; i < spamClusterIds.length; i += DB_CHUNK) {
          const chunk = spamClusterIds.slice(i, i + DB_CHUNK);
          const { error } = await supabase
            .from("x_news_clusters")
            .update({ is_active: false })
            .in("id", chunk);

          if (error) {
            console.error(`Failed to deactivate spam clusters: ${error.message}`);
          } else {
            count += chunk.length;
          }
        }
        return count;
      });

      const summary = {
        status: "ok",
        clusters: clusters.length,
        spam_found: spamClusterIds.length,
        deactivated,
      };

      await step.run("record-success", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-monitor",
          state: "ok",
          details: summary,
        });
      });

      return summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      await step.run("record-failure", async () => {
        await recordFunctionRun({
          functionId: "x-news-cluster-monitor",
          state: "error",
          errorMessage: message,
        });
      });
      throw error;
    }
  }
);
