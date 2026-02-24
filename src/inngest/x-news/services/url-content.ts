import { Readability } from "@mozilla/readability";
import { TweetUrlsModel } from "../models";

type UrlProcessResult = {
  id: number;
  ok: boolean;
  error?: string;
};

const URL_FETCH_TIMEOUT_MS = 30_000;

async function fetchDirect(url: string): Promise<string> {
  const resp = await fetch(url, {
    headers: {
      // Keep this conservative to avoid being blocked by basic UA checks.
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
  });

  if (!resp.ok) {
    throw new Error(`direct fetch failed (${resp.status})`);
  }
  return resp.text();
}

async function fetchWithScrapingBee(url: string): Promise<string> {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    throw new Error("SCRAPINGBEE_API_KEY missing");
  }

  const proxyUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(url)}`;
  const proxyResp = await fetch(proxyUrl, {
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
  });

  if (proxyResp.ok) {
    return proxyResp.text();
  }

  // Fallback to premium proxy.
  const premiumUrl = `https://app.scrapingbee.com/api/v1/?api_key=${apiKey}&url=${encodeURIComponent(url)}&premium=true&country_code=us`;
  const premiumResp = await fetch(premiumUrl, {
    signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
  });

  if (!premiumResp.ok) {
    throw new Error(`scrapingbee failed (${premiumResp.status})`);
  }
  return premiumResp.text();
}

async function fetchHtml(url: string): Promise<string> {
  try {
    return await fetchDirect(url);
  } catch (directError) {
    if (!process.env.SCRAPINGBEE_API_KEY) {
      throw directError;
    }
    return fetchWithScrapingBee(url);
  }
}

async function extractReadableText(html: string): Promise<string | null> {
  const { parseHTML } = await import("linkedom");
  const { document } = parseHTML(html);
  const parsed = new Readability(document).parse();

  if (!parsed?.textContent) return null;

  const paragraphs = parsed.textContent.split(/\n+/);
  const cleaned = paragraphs
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");

  return cleaned || null;
}

export async function processTweetUrlById(id: number, url: string): Promise<UrlProcessResult> {
  try {
    const html = await fetchHtml(url);
    const readable = await extractReadableText(html);

    await TweetUrlsModel.updateContent({
      id,
      urlContent: readable ?? "Could not extract readable content",
      rawUrlContent: html,
    });

    return { id, ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";

    // Persist failure text so the row doesn't get stuck forever.
    try {
      await TweetUrlsModel.updateContent({
        id,
        urlContent: `Error fetching content: ${message}`,
        rawUrlContent: null,
      });
    } catch (updateError) {
      const updateMessage =
        updateError instanceof Error ? updateError.message : String(updateError);
      return {
        id,
        ok: false,
        error: `${message}; failed to persist error: ${updateMessage}`,
      };
    }

    return { id, ok: false, error: message };
  }
}
