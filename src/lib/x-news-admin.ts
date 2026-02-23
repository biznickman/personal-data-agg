import { cookies } from "next/headers";
import { NextRequest } from "next/server";

export const X_NEWS_ADMIN_COOKIE = "x_news_admin";

function getConfiguredAdminToken(): string | null {
  const token = process.env.X_NEWS_ADMIN_TOKEN?.trim();
  return token || null;
}

export function isAdminRequest(request: NextRequest): boolean {
  const configured = getConfiguredAdminToken();
  if (!configured) return false;
  return request.cookies.get(X_NEWS_ADMIN_COOKIE)?.value === configured;
}

export async function isAdminSession(): Promise<boolean> {
  const configured = getConfiguredAdminToken();
  if (!configured) return false;
  const cookieStore = await cookies();
  return cookieStore.get(X_NEWS_ADMIN_COOKIE)?.value === configured;
}

export function getAdminTokenForSession(): string | null {
  return getConfiguredAdminToken();
}

