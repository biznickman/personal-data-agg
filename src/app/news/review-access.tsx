"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface ReviewAccessProps {
  isAdmin: boolean;
}

interface ApiResponse {
  status: "ok" | "error";
  message?: string;
}

export function ReviewAccess({ isAdmin }: ReviewAccessProps) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  async function login(): Promise<void> {
    if (!token.trim()) return;
    setIsLoading(true);
    setStatus(null);

    try {
      const response = await fetch("/api/x-news/admin/session", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });
      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || payload.status !== "ok") {
        throw new Error(payload.message ?? "Login failed");
      }

      setToken("");
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatus(message);
    } finally {
      setIsLoading(false);
    }
  }

  async function logout(): Promise<void> {
    setIsLoading(true);
    setStatus(null);
    try {
      await fetch("/api/x-news/admin/session", {
        method: "DELETE",
      });
      router.refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      setStatus(message);
    } finally {
      setIsLoading(false);
    }
  }

  if (isAdmin) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm">
        <div className="flex items-center gap-3">
          <span className="text-green-300">Admin session active</span>
          <button
            type="button"
            onClick={logout}
            disabled={isLoading}
            className="px-2 py-1 rounded border border-slate-600 text-slate-200 disabled:opacity-60"
          >
            Sign out
          </button>
        </div>
        {status ? <p className="mt-2 text-red-300 text-xs">{status}</p> : null}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm space-y-3">
      <p className="text-slate-300">Admin token required for story review feedback.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="Admin token"
          className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-slate-200"
        />
        <button
          type="button"
          onClick={login}
          disabled={isLoading || !token.trim()}
          className="px-3 py-1 rounded border border-cyan-500/60 text-cyan-200 bg-cyan-500/10 disabled:opacity-60"
        >
          {isLoading ? "Checking..." : "Unlock review"}
        </button>
      </div>
      {status ? <p className="text-red-300 text-xs">{status}</p> : null}
    </div>
  );
}

