import Link from "next/link";

const NAV_ITEMS = [
  { label: "News", href: "/" },
  { label: "Status", href: "/status" },
  { label: "Review", href: "/news/review" },
  { label: "All Clusters", href: "/news" },
];

export function SiteHeader() {
  const now = new Date();
  const formattedDate = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    <header className="border-b" style={{ borderColor: "var(--tm-border)" }}>
      <div className="max-w-[84em] mx-auto px-4 sm:px-6 py-3">
        <div className="flex items-baseline justify-between">
          <Link href="/" className="no-underline">
            <h1
              className="text-xl sm:text-2xl font-bold tracking-tight"
              style={{ color: "var(--tm-headline)", fontFamily: "var(--tm-font-nav)" }}
            >
              CHOOSE RICH LIVE
            </h1>
          </Link>
          <span
            className="text-sm hidden sm:inline"
            style={{ color: "var(--tm-text-muted)" }}
          >
            {formattedDate}
          </span>
        </div>
        <nav className="mt-1 flex gap-4 text-sm" style={{ fontFamily: "var(--tm-font-nav)" }}>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="tm-link"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
    </header>
  );
}
