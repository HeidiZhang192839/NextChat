/**
 * @jest-environment node
 */
import { jest } from "@jest/globals";
import { NextRequest } from "next/server";

type Handler = (req: NextRequest) => Promise<Response>;
let GET: Handler, POST: Handler;

const fetchMock = jest.fn<typeof fetch>();

beforeAll(async () => {
  // access codes are read when the server config is first loaded
  process.env.CODE = "secret";
  ({ GET, POST } = (await import("../app/api/code-proxy/route")) as any);
  global.fetch = fetchMock;
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(
    new Response("hello", {
      status: 201,
      headers: {
        "content-type": "text/plain",
        "content-encoding": "gzip",
        "set-cookie": "a=b",
      },
    }),
  );
});

function request(target: string, init: RequestInit = {}, code = "secret") {
  const headers = new Headers(init.headers);
  if (code) headers.set("Authorization", `Bearer nk-${code}`);
  return new NextRequest(
    `http://localhost/api/code-proxy?url=${encodeURIComponent(target)}`,
    { ...init, headers } as any,
  );
}

describe("code-proxy", () => {
  test("needs the access code", async () => {
    expect((await GET(request("https://a.test", {}, ""))).status).toBe(401);
    expect((await GET(request("https://a.test", {}, "wrong"))).status).toBe(
      401,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("only proxies http(s) urls", async () => {
    expect((await GET(request("file:///etc/passwd"))).status).toBe(400);
    expect((await GET(request("not a url"))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("forwards python's method, headers and body", async () => {
    const res = await POST(
      request("https://a.test/post?q=1", {
        method: "POST",
        body: '{"a":1}',
        headers: {
          "X-Proxy-Headers": JSON.stringify({
            "Content-Type": "application/json",
            "X-Test": "yes",
          }),
        },
      }),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe("https://a.test/post?q=1");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-Test": "yes",
    });
    // the app's own auth header isn't sent to the site
    expect(init?.headers).not.toHaveProperty("Authorization");
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe('{"a":1}');

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("hello");
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  test("reports sites it can't reach", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    const res = await GET(request("https://a.test"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toContain("a.test");
  });
});
