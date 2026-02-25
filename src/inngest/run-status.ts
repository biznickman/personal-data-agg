import { supabase } from "@/lib/supabase";

export type IngestionFunctionId =
  | "x-news-ingest"
  | "x-keyword-scan"
  | "x-news-enrich-urls"
  | "x-news-normalize"
  | "x-news-cluster-assign"
  | "x-news-cluster-merge"
  | "x-news-cluster-backfill"
  | "x-news-cluster-sync"
  | "x-news-cluster-review"
  | "granola-ingest"
  | "message-log-ingest"
  | "slack-ingest"
  | "x-posts-fetch-recent"
  | "x-posts-update-analytics"
  | "x-posts-archive";

type RunState = "ok" | "error";

interface RecordRunParams {
  functionId: IngestionFunctionId;
  state: RunState;
  details?: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * Best-effort run tracking for dashboard/health views.
 * If the table does not exist yet, we keep ingestion running.
 */
export async function recordFunctionRun({
  functionId,
  state,
  details,
  errorMessage,
}: RecordRunParams): Promise<void> {
  const payload = {
    function_id: functionId,
    status: state,
    last_run_at: new Date().toISOString(),
    details: details ?? {},
    error_message: errorMessage ?? null,
  };

  const { error } = await supabase.from("ingestion_runs").upsert(payload, {
    onConflict: "function_id",
  });

  if (error) {
    console.warn(
      `Unable to record run status for ${functionId}: ${error.message}`
    );
  }
}
