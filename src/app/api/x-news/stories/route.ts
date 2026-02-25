import { NextRequest, NextResponse } from "next/server";
import { getLatestXNewsStories } from "@/lib/x-news-stories";

export const dynamic = "force-dynamic";

function parseIntParam(raw: string | null, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBooleanParam(raw: string | null, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) return true;
  if (["0", "false", "no", "n"].includes(normalized)) return false;
  return fallback;
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const limit = parseIntParam(searchParams.get("limit"), 20);
    const lookbackHours = parseIntParam(searchParams.get("hours"), 24);
    const onlyStoryCandidates = parseBooleanParam(searchParams.get("storyCandidatesOnly"), true);
    const maxTweetsPerStory = parseIntParam(searchParams.get("tweetsPerStory"), 5);
    const sortParam = searchParams.get("sort")?.trim().toLowerCase();
    const sortByRecent = sortParam === "recent";

    const stories = await getLatestXNewsStories({
      limit,
      lookbackHours,
      onlyStoryCandidates,
      maxTweetsPerStory,
    });

    if (sortByRecent) {
      stories.sort((a, b) => {
        const ta = a.lastSeenAt ? new Date(a.lastSeenAt).getTime() : 0;
        const tb = b.lastSeenAt ? new Date(b.lastSeenAt).getTime() : 0;
        return tb - ta;
      });
    }

    return NextResponse.json({
      status: "ok",
      lookback_hours: lookbackHours,
      story_candidates_only: onlyStoryCandidates,
      sort: sortByRecent ? "recent" : "ranked",
      count: stories.length,
      stories,
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
