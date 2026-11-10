/**
 * @jest-environment node
 */
import { jest } from "@jest/globals";

test("a burst of saves writes the first and the latest state, one at a time", async () => {
  // the app loads the store first, entering at utils/store hits an import cycle
  await import("../app/store");
  const { throttleWrites } = await import("../app/utils/store");
  jest.useFakeTimers();
  const written: number[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const storage = throttleWrites<number>({
    getItem: () => null,
    removeItem: () => {},
    async setItem(_name, value) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 50));
      written.push(value.state);
      inFlight -= 1;
    },
  });

  // a reply streaming for 3 seconds at 60 updates a second
  for (let i = 1; i <= 180; i++) {
    storage.setItem("chat", { state: i, version: 1 });
    await jest.advanceTimersByTimeAsync(1000 / 60);
  }
  await jest.advanceTimersByTimeAsync(5000);

  expect(written[0]).toBe(1);
  expect(written.at(-1)).toBe(180);
  expect(written.length).toBeLessThanOrEqual(5);
  expect(maxInFlight).toBe(1);
  jest.useRealTimers();
});
