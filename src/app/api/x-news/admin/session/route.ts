import { NextRequest, NextResponse } from "next/server";
import {
  getAdminTokenForSession,
  X_NEWS_ADMIN_COOKIE,
} from "@/lib/x-news-admin";

export const dynamic = "force-dynamic";

function createCookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  };
}

export async function POST(request: NextRequest) {
  try {
    const configured = getAdminTokenForSession();
    if (!configured) {
      return NextResponse.json(
        {
          status: "error",
          message: "X_NEWS_ADMIN_TOKEN is not configured",
        },
        { status: 500 }
      );
    }

    const body = (await request.json().catch(() => ({}))) as {
      token?: unknown;
    };
    const token = typeof body.token === "string" ? body.token.trim() : "";

    if (!token || token !== configured) {
      return NextResponse.json(
        {
          status: "error",
          message: "Invalid token",
        },
        { status: 401 }
      );
    }

    const response = NextResponse.json({ status: "ok" });
    response.cookies.set(X_NEWS_ADMIN_COOKIE, configured, createCookieOptions());
    return response;
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

export async function DELETE() {
  const response = NextResponse.json({ status: "ok" });
  response.cookies.set(X_NEWS_ADMIN_COOKIE, "", {
    ...createCookieOptions(),
    maxAge: 0,
  });
  return response;
}

