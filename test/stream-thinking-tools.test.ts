/**
 * @jest-environment node
 */
import { jest } from "@jest/globals";

// same split as app/components/markdown.tsx
function splitThinking(text: string) {
  if (!text.startsWith("> ")) return ["", text];
  const end = text.search(/\n\n(?!> )/);
  return end === -1 ? [text, ""] : [text.slice(0, end), text.slice(end + 2)];
}

function sse(deltas: object[], finishReason: string) {
  const body =
    deltas
      .map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      .join("") +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: finishReason }],
    })}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

// the parseSSE of app/client/platforms/openai.ts, reduced to what the test sends
function parseSSE(text: string, runTools: any[]) {
  const delta = JSON.parse(text).choices[0].delta;
  if (delta.tool_calls) runTools.push(delta.tool_calls[0]);
  if (delta.reasoning_content)
    return { isThinking: true, content: delta.reasoning_content };
  return { isThinking: false, content: delta.content ?? "" };
}

test("thinking and tool calls of every round stay in the thinking block", async () => {
  const fetchMock = jest
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      sse(
        [
          { reasoning_content: "I should run code." },
          { content: "Let me check." },
          {
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "run_python", arguments: "{}" },
              },
            ],
          },
        ],
        "tool_calls",
      ),
    )
    .mockResolvedValueOnce(
      sse(
        [
          { reasoning_content: "The result is 42." },
          { content: "The answer is 42." },
        ],
        "stop",
      ),
    );
  // the app loads the store first, entering at utils/chat hits an import cycle
  await import("../app/store");
  const { streamWithThink } = await import("../app/utils/chat");
  Object.assign(globalThis, {
    window: { fetch: fetchMock },
    document: { hidden: false },
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  });
  // Node 18 has no navigator, newer versions have a read-only one
  (globalThis as any).navigator ??= {};

  const updates: string[] = [];
  const message = await new Promise<string>((onFinish) =>
    streamWithThink(
      "/chat",
      { messages: [] },
      {},
      [{}],
      { run_python: async () => ({ status: 200, data: "42" }) },
      new AbortController(),
      parseSSE,
      (payload, call, results) => payload.messages.push(call, ...results),
      { onUpdate: (text: string) => updates.push(text), onFinish },
    ),
  );

  expect(updates).toContain(
    "> I should run code.\n> \n> Let me check.\n> \n> - ⏳ `run_python`",
  );
  const [thinking, answer] = splitThinking(message);
  expect(thinking).toBe(
    "> I should run code.\n> \n> Let me check.\n> \n> - ✅ `run_python`\n\n> The result is 42.",
  );
  expect(answer).toBe("The answer is 42.");
  // let the response animation see the end before the environment goes away
  await new Promise((resolve) => setTimeout(resolve, 10));
});
