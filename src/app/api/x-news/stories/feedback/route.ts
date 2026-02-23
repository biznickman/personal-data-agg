import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isAdminRequest } from "@/lib/x-news-admin";

export const dynamic = "force-dynamic";

type FeedbackLabel = "useful" | "noise" | "bad_cluster";

interface FeedbackSummary {
  useful: number;
  noise: number;
  badCluster: number;
  total: number;
}

interface FeedbackRow {
  label: FeedbackLabel;
}

function parseClusterId(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return Math.floor(input);
  }

  if (typeof input === "string" && input.trim()) {
    const parsed = Number.parseInt(input, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function parseLabel(input: unknown): FeedbackLabel | null {
  if (input === "useful" || input === "noise" || input === "bad_cluster") {
    return input;
  }
  return null;
}

function parseNote(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const cleaned = input.trim().replace(/\s+/g, " ");
  if (!cleaned) return null;
  return cleaned.slice(0, 500);
}

function summarizeFeedback(rows: FeedbackRow[]): FeedbackSummary {
  const summary: FeedbackSummary = {
    useful: 0,
    noise: 0,
    badCluster: 0,
    total: 0,
  };

  for (const row of rows) {
    if (row.label === "useful") summary.useful += 1;
    if (row.label === "noise") summary.noise += 1;
    if (row.label === "bad_cluster") summary.badCluster += 1;
    summary.total += 1;
  }

  return summary;
}

export async function POST(request: NextRequest) {
  try {
    if (!isAdminRequest(request)) {
      return NextResponse.json(
        {
          status: "error",
          message: "Unauthorized",
        },
        { status: 401 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      clusterId?: unknown;
      label?: unknown;
      note?: unknown;
    };

    const clusterId = parseClusterId(body.clusterId);
    const label = parseLabel(body.label);
    const note = parseNote(body.note);

    if (!clusterId || !label) {
      return NextResponse.json(
        {
          status: "error",
          message: "Invalid feedback payload",
        },
        { status: 400 }
      );
    }

    const { data: cluster, error: clusterError } = await supabase
      .from("x_news_clusters")
      .select("id")
      .eq("id", clusterId)
      .maybeSingle();

    if (clusterError) {
      throw new Error(`Cluster lookup failed: ${clusterError.message}`);
    }

    if (!cluster?.id) {
      return NextResponse.json(
        {
          status: "error",
          message: "Cluster not found",
        },
        { status: 404 }
      );
    }

    const { error: insertError } = await supabase.from("x_news_cluster_feedback").insert({
      cluster_id: clusterId,
      label,
      note,
    });

    if (insertError) {
      throw new Error(`Feedback insert failed: ${insertError.message}`);
    }

    const { data: feedbackRows, error: feedbackError } = await supabase
      .from("x_news_cluster_feedback")
      .select("label")
      .eq("cluster_id", clusterId)
      .order("created_at", { ascending: false })
      .limit(1000);

    if (feedbackError) {
      throw new Error(`Feedback summary query failed: ${feedbackError.message}`);
    }

    const summary = summarizeFeedback((feedbackRows ?? []) as FeedbackRow[]);

    return NextResponse.json({
      status: "ok",
      cluster_id: clusterId,
      summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        status: "error",
        message,
      },
      { status: 500 }
    );
  }
}
