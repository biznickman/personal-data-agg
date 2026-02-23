"use client";

import { useState } from "react";

type FeedbackLabel = "useful" | "noise" | "bad_cluster";

interface FeedbackSummary {
  useful: number;
  noise: number;
  badCluster: number;
  total: number;
}

interface StoryFeedbackProps {
  clusterId: number;
  initialSummary: FeedbackSummary;
}

interface FeedbackResponse {
  status: "ok" | "error";
  summary?: FeedbackSummary;
  message?: string;
}

export function StoryFeedback({ clusterId, initialSummary }: StoryFeedbackProps) {
  const [summary, setSummary] = useState<FeedbackSummary>(initialSummary);
  const [status, setStatus] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [note, setNote] = useState("");

  async function submit(label: FeedbackLabel): Promise<void> {
    if (isSending) return;

    setIsSending(true);
    setStatus(null);

    try {
      const response = await fetch("/api/x-news/stories/feedback", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          clusterId,
          label,
          note: note.trim() || undefined,
        }),
      });

      const payload = (await response.json()) as FeedbackResponse;
      if (!response.ok || payload.status !== "ok") {
        throw new Error(payload.message ?? "Feedback request failed");
      }

      if (payload.summary) {
        setSummary(payload.summary);
      }

      setNote("");
      setStatus("saved");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatus(`error: ${message}`);
    } finally {
      setIsSending(false);
    }
  }

  return (
    <div className="rounded border border-slate-800 bg-slate-950/50 p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
        <span>Feedback</span>
        <button
          type="button"
          onClick={() => submit("useful")}
          disabled={isSending}
          className="px-2 py-1 rounded border border-emerald-500/50 text-emerald-300 bg-emerald-500/10 disabled:opacity-60"
        >
          useful ({summary.useful})
        </button>
        <button
          type="button"
          onClick={() => submit("noise")}
          disabled={isSending}
          className="px-2 py-1 rounded border border-amber-500/50 text-amber-300 bg-amber-500/10 disabled:opacity-60"
        >
          noise ({summary.noise})
        </button>
        <button
          type="button"
          onClick={() => submit("bad_cluster")}
          disabled={isSending}
          className="px-2 py-1 rounded border border-rose-500/50 text-rose-300 bg-rose-500/10 disabled:opacity-60"
        >
          bad cluster ({summary.badCluster})
        </button>
        <span className="text-slate-500">total {summary.total}</span>
        {status ? (
          <span className={status === "saved" ? "text-green-300" : "text-red-300"}>{status}</span>
        ) : null}
      </div>
      <input
        value={note}
        onChange={(event) => setNote(event.target.value)}
        maxLength={500}
        placeholder="Optional note (what seems wrong/right)"
        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
      />
    </div>
  );
}

