import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";

const TIMEOUT_MS = 120_000;
// these describe this server's connection to the site, not the response itself
const DROP_RESPONSE_HEADERS = [
  "connection",
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
];

// network access for the code execution tool (public/python-worker.js) to sites
// that don't allow cross-origin reads from the browser: the request is made from
// here, with python's own request headers json encoded in x-proxy-headers
async function handle(req: NextRequest) {
  // same access code check as the model routes
  const authResult = auth(req, ModelProvider.GPT);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }

  const target = req.nextUrl.searchParams.get("url");
  let url: URL;
  try {
    url = new URL(target ?? "");
  } catch {
    return NextResponse.json({ error: "invalid url" }, { status: 400 });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return NextResponse.json(
      { error: "only http(s) urls are supported" },
      { status: 400 },
    );
  }
  let headers: Record<string, string>;
  try {
    headers = JSON.parse(req.headers.get("x-proxy-headers") ?? "{}");
  } catch {
    return NextResponse.json(
      { error: "invalid x-proxy-headers" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(url, {
      method: req.method,
      headers: {
        // browsers don't let python set it, and some sites block node's default
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        ...headers,
      },
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : await req.arrayBuffer(),
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const resHeaders = new Headers(res.headers);
    DROP_RESPONSE_HEADERS.forEach((name) => resHeaders.delete(name));
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `couldn't reach ${url.host}: ${e}` },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
