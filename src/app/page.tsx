import Link from "next/link";
import { getSystemHealth, type FunctionHealth } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

function formatDate(value: string | null): string {
  if (!value) return "n/a";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "n/a";
  return date.toLocaleString();
}

function statusClasses(status: FunctionHealth["status"]): string {
  if (status === "ok") return "bg-green-600/20 text-green-200 border-green-500/50";
  if (status === "stale") return "bg-amber-600/20 text-amber-200 border-amber-500/50";
  if (status === "error") return "bg-red-600/20 text-red-200 border-red-500/50";
  return "bg-slate-600/20 text-slate-200 border-slate-500/50";
}

export default async function Home() {
  const health = await getSystemHealth();

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10">
      <div className="max-w-6xl mx-auto space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">Ingestion Engine</h1>
          <p className="text-slate-400">
            API-driven ingestion pipeline with Inngest scheduling and Supabase storage.
          </p>
          <div className="text-sm text-slate-300">
            <span className="mr-2">Overall:</span>
            <span
              className={`inline-flex px-2 py-1 rounded border ${statusClasses(
                health.overall === "degraded" ? "stale" : health.overall
              )}`}
            >
              {health.overall}
            </span>
            <span className="ml-4 text-slate-400">Checked: {formatDate(health.checkedAt)}</span>
          </div>
        </header>

        <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {health.functions.map((item) => (
            <article
              key={item.id}
              className="rounded-lg border border-slate-800 bg-slate-900/70 p-5 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-medium">{item.name}</h2>
                  <p className="text-sm text-slate-400">{item.schedule}</p>
                </div>
                <span className={`inline-flex px-2 py-1 rounded border ${statusClasses(item.status)}`}>
                  {item.status}
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <dt className="text-slate-400">Rows</dt>
                  <dd>{item.rowCount?.toLocaleString() ?? "n/a"}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Latest Data</dt>
                  <dd>{formatDate(item.latestDataAt)}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Last Run</dt>
                  <dd>{formatDate(item.lastRunAt)}</dd>
                </div>
                <div>
                  <dt className="text-slate-400">Function ID</dt>
                  <dd className="font-mono text-xs">{item.id}</dd>
                </div>
              </dl>

              {item.errorMessage ? (
                <p className="text-sm text-red-300">Last error: {item.errorMessage}</p>
              ) : null}
              {item.queryError ? (
                <p className="text-sm text-red-300">Supabase query error: {item.queryError}</p>
              ) : null}

              <div className="flex gap-3 text-sm">
                <Link href={item.logsUrl} className="text-cyan-300 hover:text-cyan-200 underline">
                  Inngest logs
                </Link>
              </div>
            </article>
          ))}
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/50 p-5 text-sm">
          <p>Supabase connection: {health.supabase.ok ? "ok" : "error"}</p>
          {health.supabase.error ? (
            <p className="text-red-300 mt-1">Error: {health.supabase.error}</p>
          ) : null}
          <p className="mt-2">
            Health endpoint:{" "}
            <Link href="/api/health" className="text-cyan-300 hover:text-cyan-200 underline">
              /api/health
            </Link>
          </p>
        </section>
      </div>
    </main>
  );
}
