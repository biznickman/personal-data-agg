import Link from "next/link";
import { getLatestXNewsStories } from "@/lib/x-news-stories";
import { NewsBackfillControls } from "./backfill-controls";
import { StoryList } from "./story-list";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{
  hours?: string;
  view?: string;
  limit?: string;
}>;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function isStoryOnlyView(value: string | undefined): boolean {
  return value === "stories";
}

function getViewParam(storyOnly: boolean): "stories" | "all" {
  return storyOnly ? "stories" : "all";
}

export default async function NewsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const hours = parsePositiveInt(params.hours, 24);
  const limit = parsePositiveInt(params.limit, 100);
  const storyOnly = isStoryOnlyView(params.view);
  const viewParam = getViewParam(storyOnly);

  const stories = await getLatestXNewsStories({
    lookbackHours: hours,
    limit,
    onlyStoryCandidates: storyOnly,
    maxTweetsPerStory: 10,
  });

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">X News Stories</h1>
          <p className="text-slate-400">
            Normalized + clustered stories from the X ingestion pipeline.
          </p>
          <div className="flex flex-wrap gap-2 text-sm">
            <Link
              href={`/news?hours=${hours}&view=stories&limit=${limit}`}
              className={`px-3 py-1 rounded border ${
                storyOnly
                  ? "border-cyan-400/60 text-cyan-200 bg-cyan-500/10"
                  : "border-slate-700 text-slate-300"
              }`}
            >
              Story candidates
            </Link>
            <Link
              href={`/news?hours=${hours}&view=all&limit=${limit}`}
              className={`px-3 py-1 rounded border ${
                !storyOnly
                  ? "border-cyan-400/60 text-cyan-200 bg-cyan-500/10"
                  : "border-slate-700 text-slate-300"
              }`}
            >
              All clusters
            </Link>
            <Link
              href={`/news?hours=24&view=${viewParam}&limit=${limit}`}
              className={`px-3 py-1 rounded border ${
                hours === 24
                  ? "border-cyan-400/60 text-cyan-200 bg-cyan-500/10"
                  : "border-slate-700 text-slate-300"
              }`}
            >
              24h
            </Link>
            <Link
              href={`/news?hours=72&view=${viewParam}&limit=${limit}`}
              className={`px-3 py-1 rounded border ${
                hours === 72
                  ? "border-cyan-400/60 text-cyan-200 bg-cyan-500/10"
                  : "border-slate-700 text-slate-300"
              }`}
            >
              72h
            </Link>
            <Link href="/news/preview" className="px-3 py-1 rounded border border-cyan-500/60 text-cyan-200">
              Embedding Preview
            </Link>
            <Link href="/news/review" className="px-3 py-1 rounded border border-amber-500/60 text-amber-200">
              Review
            </Link>
          </div>
          <p className="text-xs text-slate-500">
            Showing {stories.length} clusters • window: last {hours}h • mode:{" "}
            {storyOnly ? "story candidates" : "all clusters"}
          </p>
        </header>

        <NewsBackfillControls />

        <section className="space-y-3">
          <StoryList stories={stories} showFeedback={false} />
        </section>
      </div>
    </main>
  );
}
