/**
 * @jest-environment node
 */
import { jest } from "@jest/globals";

jest.mock("@/app/locales", () => ({
  __esModule: true,
  default: { Error: { Unauthorized: "Unauthorized" } },
}));
jest.unstable_mockModule("@/app/locales", () => ({
  __esModule: true,
  default: { Error: { Unauthorized: "Unauthorized" } },
}));

test("detects challenge pages and points to the configured API origin", async () => {
  Object.assign(globalThis, { window: {} });
  const { ApiPageError, checkApiResponse } = await import("../app/utils/api-page");

  expect(() =>
    checkApiResponse(
      new Response("challenge", {
        headers: {
          "cf-mitigated": "challenge",
          "content-type": "text/html",
        },
      }),
      "/api/proxy/v1/models",
      { "X-Base-URL": "https://api.example.com/v1" },
    ),
  ).toThrow(ApiPageError);

  try {
    checkApiResponse(
      new Response("challenge", {
        headers: { "content-type": "text/html" },
      }),
      "/api/proxy/v1/models",
      { "X-Base-URL": "https://api.example.com/v1" },
    );
  } catch (error) {
    expect(error).toMatchObject({ site: "https://api.example.com", browserRequest: false });
  }
});

test("HTML API bodies are not surfaced as model data", async () => {
  Object.assign(globalThis, { window: {} });
  const { checkApiResponse } = await import("../app/utils/api-page");
  const response = new Response("<html>verify</html>", {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

  expect(() => checkApiResponse(response, "https://api.example.com/v1/models"))
    .toThrow("web page");
});

test("a challenge in a streaming chat fails without retrying the request", async () => {
  const response = new Response("<html>verify</html>", {
    headers: { "content-type": "text/html" },
  });
  const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(response);
  const { streamWithThink } = await import("../app/utils/chat");
  Object.assign(globalThis, {
    window: {
      fetch: fetchMock,
      addEventListener() {},
      removeEventListener() {},
    },
    document: { hidden: false },
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  });
  (globalThis as any).navigator ??= {};

  const onError = jest.fn();
  const onFinish = jest.fn();
  await new Promise<void>((resolve) => {
    streamWithThink(
      "/chat",
      { messages: [] },
      {},
      [],
      {},
      new AbortController(),
      () => ({ isThinking: false, content: "" }),
      () => {},
      { onError: (error: Error) => { onError(error); resolve(); }, onFinish },
    );
  });

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0]).toMatchObject({ browserRequest: true });
  expect(onFinish).not.toHaveBeenCalled();
});
