import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/app/api/auth";
import { ModelProvider } from "@/app/constant";
import { extractText } from "unpdf";

// download size cap so one huge file can't exhaust server memory;
// text length is not capped here, the client summarizes long pages
const MAX_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 15000;

// read the response body, or return null if it is bigger than MAX_BYTES
async function readBody(res: Response) {
  const reader = res.body!.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    data.set(chunk, offset);
    offset += chunk.length;
  }
  return data;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

// crude html -> plain text, good enough for feeding page content to the model
function htmlToText(html: string) {
  return html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(
      /<(script|style|noscript|svg|iframe|template|head|nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi,
      "",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|pre|blockquote)>/gi, "\n")
    .replace(/<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// turn <a href="x">text</a> into "text [absolute x]" so the model can follow links
function keepLinks(html: string, baseUrl: string) {
  return html.replace(
    /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi,
    (m, dq, sq, bare, inner) => {
      const href = (dq ?? sq ?? bare).trim();
      if (!inner.replace(/<[^>]*>/g, "").trim()) return m;
      try {
        const url = new URL(href, baseUrl);
        if (url.protocol !== "http:" && url.protocol !== "https:") return m;
        // skip in-page anchors
        if (url.hash && url.href.split("#")[0] === baseUrl.split("#")[0]) {
          return m;
        }
        return `${inner} [${url.href}]`;
      } catch {
        return m;
      }
    },
  );
}

// web page reader tool backend, fetches a url and returns its text content
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

  try {
    const res = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
      },
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `page responded ${res.status} ${res.statusText}` },
        { status: 502 },
      );
    }
    const contentType = res.headers.get("content-type") ?? "";
    const data = await readBody(res);
    if (!data) {
      return NextResponse.json(
        { error: `page is larger than ${MAX_BYTES / 1024 / 1024} MB` },
        { status: 413 },
      );
    }
    // some servers send pdfs as application/octet-stream, so also sniff the magic bytes
    const isPdf =
      contentType.includes("pdf") ||
      new TextDecoder().decode(data.slice(0, 5)) === "%PDF-";
    let title: string | undefined;
    let text: string;
    if (isPdf) {
      text = (await extractText(data, { mergePages: true })).text;
    } else if (/text\/|html|xml|json/.test(contentType)) {
      const body = new TextDecoder().decode(data);
      title = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
      text = contentType.includes("html")
        ? htmlToText(keepLinks(body, res.url))
        : body;
    } else {
      return NextResponse.json(
        { error: `unsupported content type: ${contentType}` },
        { status: 415 },
      );
    }
    return NextResponse.json({
      url: res.url,
      title: title ? htmlToText(title) : undefined,
      content: text,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `fetching page failed: ${e}` },
      { status: 502 },
    );
  }
}

export const GET = handle;
