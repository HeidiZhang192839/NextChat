import { jest } from "@jest/globals";

const render = jest.fn<(element: any) => void>();
const unmount = jest.fn();

jest.unstable_mockModule("react-dom/client", () => ({
  createRoot: () => ({ render, unmount }),
}));
jest.unstable_mockModule("@/app/locales", () => ({
  default: { UI: { Confirm: "Confirm", Cancel: "Cancel" } },
}));
jest.unstable_mockModule("@/app/components/emoji", () => ({
  Avatar: () => null,
}));

// Only inspect the rendered modal's callbacks; no Google popup is involved.
const { showConfirm } = await import("../app/components/ui-lib");

beforeEach(() => {
  render.mockClear();
  unmount.mockClear();
});

test.each([
  ["confirm", true],
  ["cancel", false],
  ["close", false],
] as const)(
  "%s resolves the confirmation and removes the modal",
  async (action, expected) => {
    const result = showConfirm("Replace this device's cloud backup?");
    const modal = render.mock.calls[0][0];
    expect(document.querySelector(".modal-mask")).not.toBeNull();

    if (action === "close") {
      // Both the close button and Escape invoke this callback.
      modal.props.onClose();
    } else {
      modal.props.actions[action === "confirm" ? 1 : 0].props.onClick();
    }

    expect(await result).toBe(expected);
    expect(unmount).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".modal-mask")).toBeNull();
  },
);
