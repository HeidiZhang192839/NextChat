import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";

const MAX_RESULTS = 8;

// web search tool backend, proxies to a self-hosted SearXNG instance
// (SearXNG must have `json` enabled in `search.formats` of settings.yml)
async function handle(req: NextRequest) {
  // same access code check as the model routes
  const authResult = auth(req, ModelProvider.GPT);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  const searxngUrl = process.env.SEARXNG_URL;
  if (!searxngUrl) {
    return NextResponse.json(
      { error: "SEARXNG_URL is not configured on the server" },
      { status: 500 },
    );
  }

  const query = req.nextUrl.searchParams.get("q");
  if (!query) {
    return NextResponse.json({ error: "missing query" }, { status: 400 });
  }

  const url = new URL("/search", searxngUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return NextResponse.json(
        { error: `SearXNG responded ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }
    const json = await res.json();
    const results = (json.results ?? [])
      .slice(0, MAX_RESULTS)
      .map((r: any) => ({ title: r.title, url: r.url, content: r.content }));
    return NextResponse.json({ query, results });
  } catch (e) {
    return NextResponse.json(
      { error: `SearXNG request failed: ${e}` },
      { status: 502 },
    );
  }
}

export const GET = handle;
