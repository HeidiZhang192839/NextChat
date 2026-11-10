/**
 * @jest-environment node
 */
import { jest } from "@jest/globals";

function sse(deltas: object[]) {
  const body =
    deltas
      .map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`)
      .join("") +
    `data: ${JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
    })}\n\ndata: [DONE]\n\n`;
  return new Response(body, {
    headers: { "content-type": "text/event-stream" },
  });
}

test("Continue appends to a cut-off reply without the continuation's thinking", async () => {
  const fetchMock = jest
    .fn<typeof fetch>()
    .mockResolvedValue(
      sse([{ reasoning_content: "Where was I?" }, { content: " 4." }]),
    );
  // import before faking window, which axios inspects on import
  const { useChatStore } = await import("../app/store");
  const { createMessage } = await import("../app/store/chat");
  const { CONTINUE_PROMPT } = await import("../app/utils/chat");
  Object.assign(globalThis, {
    window: {
      fetch: fetchMock,
      addEventListener() {},
      removeEventListener() {},
    },
    document: { hidden: false, head: { querySelector: () => null } },
    requestAnimationFrame: (cb: () => void) => setTimeout(cb, 0),
  });
  // Node 18 has no navigator, newer versions have a read-only one
  (globalThis as any).navigator ??= {};

  const store = useChatStore.getState();
  const bot = createMessage({
    role: "assistant",
    content: "> Adding.\n\n2 + 2 =",
    interrupted: true,
  });
  store.updateTargetSession(store.currentSession(), (session) => {
    session.messages = [
      createMessage({ role: "user", content: "2 + 2?" }),
      bot,
    ];
  });

  await store.continueMessage(bot.id);
  for (let i = 0; i < 200 && bot.streaming; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }

  expect(bot.streaming).toBe(false);
  expect(bot.interrupted).toBe(false);
  expect(bot.content).toBe("> Adding.\n\n2 + 2 = 4.");
  const sent = JSON.parse(fetchMock.mock.calls[0][1]!.body as string).messages;
  expect(sent.slice(-3)).toEqual([
    { role: "user", content: "2 + 2?" },
    { role: "assistant", content: "2 + 2 =" },
    { role: "user", content: CONTINUE_PROMPT },
  ]);
});
