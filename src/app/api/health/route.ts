import { NextResponse } from "next/server";
import { getSystemHealth } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const health = await getSystemHealth();
    const statusCode = health.overall === "error" ? 503 : 200;
    return NextResponse.json(health, { status: statusCode });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        overall: "error",
        checkedAt: new Date().toISOString(),
        error: message,
      },
      { status: 503 }
    );
  }
}
