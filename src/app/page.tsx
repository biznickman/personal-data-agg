import { getHomepageStories } from "@/lib/x-news-stories";
import { SiteHeader } from "./_components/site-header";
import { StoryClusterCard } from "./_components/story-cluster-card";
import { NewestSidebar } from "./_components/newest-sidebar";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { ranked, newest } = await getHomepageStories({
    lookbackHours: 24,
    rankedLimit: 20,
    newestLimit: 15,
    maxTweetsPerStory: 10,
  });

  return (
    <div className="theme-light min-h-screen">
      <SiteHeader />

      <main className="max-w-[84em] mx-auto px-4 sm:px-6 py-6 flex flex-col lg:flex-row gap-8">
        {/* Left column: Top News */}
        <div className="w-full lg:w-[68%]">
          <h2
            className="text-sm font-bold uppercase tracking-wide mb-3 pb-1"
            style={{
              color: "var(--tm-text-muted)",
              borderBottom: "2px solid var(--tm-border)",
              fontFamily: "var(--tm-font-nav)",
            }}
          >
            Top News
          </h2>

          {ranked.length === 0 ? (
            <p style={{ color: "var(--tm-text-muted)" }}>
              No stories in the current window.
            </p>
          ) : (
            ranked.map((story, i) => (
              <StoryClusterCard
                key={story.clusterId}
                story={story}
                isLead={i < 2}
              />
            ))
          )}
        </div>

        {/* Right column: Newest */}
        <aside
          className="w-full lg:w-[32%] rounded-sm p-4"
          style={{ background: "var(--tm-bg-sidebar)" }}
        >
          <h2
            className="text-sm font-bold uppercase tracking-wide mb-3 pb-1"
            style={{
              color: "var(--tm-text-muted)",
              borderBottom: "2px solid var(--tm-border)",
              fontFamily: "var(--tm-font-nav)",
            }}
          >
            Newest
          </h2>
          <NewestSidebar stories={newest} />
        </aside>
      </main>

      <footer
        className="text-center text-xs py-6"
        style={{ color: "var(--tm-text-muted)" }}
      >
        Curated financial news from X, clustered and ranked.
      </footer>
    </div>
  );
}
