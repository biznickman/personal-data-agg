import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

export async function GET() {
  const previewPath = path.join(
    process.cwd(),
    "scripts",
    "output",
    "embedding-story-preview-latest.json"
  );

  try {
    const raw = await fs.readFile(previewPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return NextResponse.json({
      status: "ok",
      source: previewPath,
      data: parsed,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      {
        status: "missing",
        source: previewPath,
        message,
        hint: "Run: pnpm stories:embedding-preview -- --hours 24 --limit 300",
      },
      { status: 404 }
    );
  }
}
