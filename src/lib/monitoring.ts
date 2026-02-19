import { supabase } from "@/lib/supabase";
import type { IngestionFunctionId } from "@/inngest/run-status";

export type FunctionHealthStatus = "ok" | "error" | "stale" | "unknown";

interface IngestionRunRow {
  function_id: IngestionFunctionId;
  status: "ok" | "error";
  last_run_at: string | null;
  details: Record<string, unknown> | null;
  error_message: string | null;
}

interface TableStats {
  rowCount: number | null;
  latestDataAt: string | null;
  queryError: string | null;
}

export interface FunctionHealth {
  id: IngestionFunctionId;
  name: string;
  schedule: string;
  scheduleMinutes: number;
  status: FunctionHealthStatus;
  logsUrl: string;
  rowCount: number | null;
  latestDataAt: string | null;
  lastRunAt: string | null;
  errorMessage: string | null;
  queryError: string | null;
}

export interface SystemHealth {
  supabase: {
    ok: boolean;
    error: string | null;
  };
  functions: FunctionHealth[];
  overall: "ok" | "degraded" | "error";
  checkedAt: string;
}

interface FunctionConfig {
  id: IngestionFunctionId;
  name: string;
  schedule: string;
  scheduleMinutes: number;
  getStats: () => Promise<TableStats>;
}

const INNGEST_DEV_URL = process.env.INNGEST_DEV_URL || "http://localhost:8288";

function formatLogsUrl(functionId: IngestionFunctionId): string {
  return `${INNGEST_DEV_URL}/functions/${functionId}`;
}

async function getTweetsStatsByTopic(topic: string | null): Promise<TableStats> {
  const countQuery =
    topic === null
      ? supabase.from("tweets").select("tweet_id", { count: "exact", head: true }).is("topic", null)
      : supabase.from("tweets").select("tweet_id", { count: "exact", head: true }).eq("topic", topic);

  const latestQuery =
    topic === null
      ? supabase
          .from("tweets")
          .select("tweet_time")
          .is("topic", null)
          .not("tweet_time", "is", null)
          .order("tweet_time", { ascending: false })
          .limit(1)
      : supabase
          .from("tweets")
          .select("tweet_time")
          .eq("topic", topic)
          .not("tweet_time", "is", null)
          .order("tweet_time", { ascending: false })
          .limit(1);

  const [{ count, error: countError }, { data: latestData, error: latestError }] =
    await Promise.all([countQuery, latestQuery]);

  const queryError = countError?.message || latestError?.message || null;
  const latestDataAt =
    latestData && latestData[0] && typeof latestData[0].tweet_time === "string"
      ? latestData[0].tweet_time
      : null;

  return { rowCount: count ?? null, latestDataAt, queryError };
}

async function getVoiceNotesStats(): Promise<TableStats> {
  const [{ count, error: countError }, { data: latestData, error: latestError }] =
    await Promise.all([
      supabase.from("voice_notes").select("granola_id", { count: "exact", head: true }),
      supabase
        .from("voice_notes")
        .select("created_at")
        .not("created_at", "is", null)
        .order("created_at", { ascending: false })
        .limit(1),
    ]);

  const queryError = countError?.message || latestError?.message || null;
  const latestDataAt =
    latestData && latestData[0] && typeof latestData[0].created_at === "string"
      ? latestData[0].created_at
      : null;

  return { rowCount: count ?? null, latestDataAt, queryError };
}

async function getMessageLogStats(): Promise<TableStats> {
  const [{ count, error: countError }, { data: latestData, error: latestError }] =
    await Promise.all([
      supabase.from("message_log").select("message_hash", { count: "exact", head: true }),
      supabase
        .from("message_log")
        .select("timestamp")
        .not("timestamp", "is", null)
        .order("timestamp", { ascending: false })
        .limit(1),
    ]);

  const queryError = countError?.message || latestError?.message || null;
  const latestDataAt =
    latestData && latestData[0] && typeof latestData[0].timestamp === "string"
      ? latestData[0].timestamp
      : null;

  return { rowCount: count ?? null, latestDataAt, queryError };
}

async function getXPostsStats(): Promise<TableStats> {
  const [{ count, error: countError }, { data: latestData, error: latestError }] =
    await Promise.all([
      supabase.from("x_posts").select("tweet_id", { count: "exact", head: true }),
      supabase
        .from("x_posts")
        .select("tweet_time")
        .not("tweet_time", "is", null)
        .order("tweet_time", { ascending: false })
        .limit(1),
    ]);

  const queryError = countError?.message || latestError?.message || null;
  const latestDataAt =
    latestData && latestData[0] && typeof latestData[0].tweet_time === "string"
      ? latestData[0].tweet_time
      : null;

  return { rowCount: count ?? null, latestDataAt, queryError };
}

async function getXPostsAnalyticsStats(): Promise<TableStats> {
  const [{ count, error: countError }, { data: latestData, error: latestError }] =
    await Promise.all([
      supabase
        .from("x_posts")
        .select("tweet_id", { count: "exact", head: true })
        .not("analytics_updated_at", "is", null),
      supabase
        .from("x_posts")
        .select("analytics_updated_at")
        .not("analytics_updated_at", "is", null)
        .order("analytics_updated_at", { ascending: false })
        .limit(1),
    ]);

  const queryError = countError?.message || latestError?.message || null;
  const latestDataAt =
    latestData && latestData[0] && typeof latestData[0].analytics_updated_at === "string"
      ? latestData[0].analytics_updated_at
      : null;

  return { rowCount: count ?? null, latestDataAt, queryError };
}

const FUNCTION_CONFIGS: FunctionConfig[] = [
  {
    id: "x-news-ingest",
    name: "X News Ingest",
    schedule: "Every 15 minutes",
    scheduleMinutes: 15,
    getStats: () => getTweetsStatsByTopic(null),
  },
  {
    id: "x-keyword-scan",
    name: "X Keyword Scan",
    schedule: "Every hour",
    scheduleMinutes: 60,
    getStats: () => getTweetsStatsByTopic("keywords"),
  },
  {
    id: "granola-ingest",
    name: "Granola Notes",
    schedule: "Every 30 minutes",
    scheduleMinutes: 30,
    getStats: getVoiceNotesStats,
  },
  {
    id: "message-log-ingest",
    name: "Message Log",
    schedule: "Every 30 minutes",
    scheduleMinutes: 30,
    getStats: getMessageLogStats,
  },
  {
    id: "x-posts-fetch-recent",
    name: "X Posts (Fetch Recent)",
    schedule: "Every 15 minutes",
    scheduleMinutes: 15,
    getStats: getXPostsStats,
  },
  {
    id: "x-posts-update-analytics",
    name: "X Posts (Analytics)",
    schedule: "Every 4 hours",
    scheduleMinutes: 240,
    getStats: getXPostsAnalyticsStats,
  },
];

function isStale(timestamp: string, scheduleMinutes: number): boolean {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return true;
  const staleMs = scheduleMinutes * 2 * 60 * 1000;
  return Date.now() - date.getTime() > staleMs;
}

function resolveFunctionStatus(
  run: IngestionRunRow | undefined,
  latestDataAt: string | null,
  scheduleMinutes: number,
  queryError: string | null
): FunctionHealthStatus {
  if (queryError) return "error";
  if (run?.status === "error") return "error";

  const referenceTimestamp = run?.last_run_at || latestDataAt;
  if (!referenceTimestamp) return "unknown";

  return isStale(referenceTimestamp, scheduleMinutes) ? "stale" : "ok";
}

async function getRunStatusMap(): Promise<Map<IngestionFunctionId, IngestionRunRow>> {
  const { data, error } = await supabase
    .from("ingestion_runs")
    .select("function_id,status,last_run_at,details,error_message");

  if (error) {
    console.warn(`Unable to load ingestion run status: ${error.message}`);
    return new Map<IngestionFunctionId, IngestionRunRow>();
  }

  const rows = (data ?? []) as IngestionRunRow[];
  return new Map(rows.map((row) => [row.function_id, row]));
}

async function getSupabaseConnectionStatus(): Promise<{
  ok: boolean;
  error: string | null;
}> {
  const { error } = await supabase
    .from("tweets")
    .select("tweet_id", { head: true, count: "exact" })
    .limit(1);

  return { ok: !error, error: error?.message ?? null };
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const [supabaseStatus, runStatusMap, ...statsList] = await Promise.all([
    getSupabaseConnectionStatus(),
    getRunStatusMap(),
    ...FUNCTION_CONFIGS.map((config) => config.getStats()),
  ]);

  const functions: FunctionHealth[] = FUNCTION_CONFIGS.map((config, index) => {
    const run = runStatusMap.get(config.id);
    const stats = statsList[index];
    const status = resolveFunctionStatus(
      run,
      stats.latestDataAt,
      config.scheduleMinutes,
      stats.queryError
    );

    return {
      id: config.id,
      name: config.name,
      schedule: config.schedule,
      scheduleMinutes: config.scheduleMinutes,
      status,
      logsUrl: formatLogsUrl(config.id),
      rowCount: stats.rowCount,
      latestDataAt: stats.latestDataAt,
      lastRunAt: run?.last_run_at ?? null,
      errorMessage: run?.error_message ?? null,
      queryError: stats.queryError,
    };
  });

  const hasError = functions.some((item) => item.status === "error");
  const hasStale = functions.some((item) => item.status === "stale");
  const overall = !supabaseStatus.ok || hasError ? "error" : hasStale ? "degraded" : "ok";

  return {
    supabase: supabaseStatus,
    functions,
    overall,
    checkedAt: new Date().toISOString(),
  };
}
