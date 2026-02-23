"use client";

import { useState } from "react";

interface BackfillResponse {
  status: string;
  mode?: "unassigned" | "all" | "rebuild";
  limit?: number;
  lookback_hours?: number | null;
  ids?: string[];
  message?: string;
}

export function NewsBackfillControls() {
  const [isLoading, setIsLoading] = useState(false);
  const [response, setResponse] = useState<BackfillResponse | null>(null);
  const [mode, setMode] = useState<"unassigned" | "all" | "rebuild">("unassigned");

  async function runBackfill(): Promise<void> {
    if (mode === "rebuild") {
      const ok = window.confirm(
        "Rebuild mode clears all current clusters and recomputes from normalized tweets. Continue?"
      );
      if (!ok) return;
    }

    setIsLoading(true);
    setResponse(null);

    try {
      const res = await fetch("/api/x-news/cluster/backfill", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          mode,
          limit: 20000,
        }),
      });

      const payload = (await res.json()) as BackfillResponse;
      setResponse(payload);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setResponse({
        status: "error",
        message,
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="text-slate-300">Backfill mode</label>
        <select
          value={mode}
          onChange={(event) =>
            setMode(
              event.target.value === "all"
                ? "all"
                : event.target.value === "rebuild"
                  ? "rebuild"
                  : "unassigned"
            )
          }
          className="bg-slate-950 border border-slate-700 rounded px-2 py-1 text-slate-200"
        >
          <option value="unassigned">Unassigned only</option>
          <option value="all">All normalized tweets</option>
          <option value="rebuild">Rebuild (clear + replay all)</option>
        </select>

        <button
          type="button"
          onClick={runBackfill}
          disabled={isLoading}
          className="px-3 py-1 rounded border border-cyan-500/60 text-cyan-200 bg-cyan-500/10 disabled:opacity-60"
        >
          {isLoading ? "Queueing..." : "Run Cluster Backfill"}
        </button>
      </div>

      {response ? (
        response.status === "queued" ? (
          <p className="text-xs text-green-300">
            Backfill queued. mode={response.mode} limit={response.limit} event_ids={response.ids?.length ?? 0}
          </p>
        ) : (
          <p className="text-xs text-red-300">Backfill failed: {response.message ?? "Unknown error"}</p>
        )
      ) : null}
    </div>
  );
}
