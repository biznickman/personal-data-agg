import { NextRequest, NextResponse } from "next/server";
import { inngest } from "@/inngest/client";

export const dynamic = "force-dynamic";

type BackfillMode = "unassigned" | "all" | "rebuild";

function parsePositiveInt(input: unknown, fallback: number, max: number): number {
  if (typeof input !== "number" || !Number.isFinite(input)) return fallback;
  const parsed = Math.floor(input);
  if (parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseMode(input: unknown): BackfillMode {
  if (input === "all") return "all";
  if (input === "rebuild") return "rebuild";
  return "unassigned";
}

function parseLookbackHours(input: unknown): number | null {
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  const parsed = Math.floor(input);
  if (parsed <= 0) return null;
  return Math.min(parsed, 24 * 30);
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as {
      mode?: BackfillMode;
      limit?: number;
      lookbackHours?: number;
    };

    const mode = parseMode(body.mode);
    const limit = parsePositiveInt(body.limit, 4000, 20000);
    const lookbackHours = parseLookbackHours(body.lookbackHours);

    const eventPayload: {
      mode: BackfillMode;
      limit: number;
      lookbackHours?: number;
    } = {
      mode,
      limit,
    };

    if (lookbackHours !== null) {
      eventPayload.lookbackHours = lookbackHours;
    }

    const result = await inngest.send({
      name: "x-news/cluster.backfill.requested",
      data: eventPayload,
    });

    return NextResponse.json({
      status: "queued",
      mode,
      limit,
      lookback_hours: lookbackHours,
      ids: result.ids,
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
