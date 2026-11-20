import { jest } from "@jest/globals";
import { render, screen } from "@testing-library/react";

const showModal = jest.fn<(props: any) => void>();
const copyToClipboard = jest.fn<(value: string) => Promise<void>>();
const text = {
  Title: "The API returned a web page",
  Challenge: "Browser check required",
  Html: "The API returned HTML",
  OpenSite: "Open provider website",
  VerifyAndRetry: "Verify and retry",
  ExternalRequest: "Check the provider API URL",
  CheckEndpoint: "Check the API URL",
  Preview: "Returned page preview",
  Source: "View complete raw response",
  EmptyBody: "The response body is empty.",
  ReadFailed: "Unable to read the response body.",
  CopyResponse: "Copy raw response",
};

jest.mock("@/app/locales", () => ({
  __esModule: true,
  default: { Error: { ApiPage: text } },
}));
jest.unstable_mockModule("@/app/locales", () => ({
  default: { Error: { ApiPage: text } },
}));
jest.mock("@/app/utils", () => ({ copyToClipboard }));
jest.unstable_mockModule("@/app/utils", () => ({ copyToClipboard }));
jest.mock("@/app/components/ui-lib", () => ({ showModal }));
jest.unstable_mockModule("@/app/components/ui-lib", () => ({ showModal }));
jest.mock("../app/icons/copy.svg", () => ({
  __esModule: true,
  default: () => null,
}));

let showApiPageError: typeof import("../app/components/api-page-modal").showApiPageError;
let ApiPageError: typeof import("../app/utils/api-page").ApiPageError;

beforeAll(async () => {
  ({ showApiPageError } = await import("../app/components/api-page-modal"));
  ({ ApiPageError } = await import("../app/utils/api-page"));
});

beforeEach(() => {
  showModal.mockClear();
  copyToClipboard.mockClear();
});

test("previews the returned HTML in a sandbox and includes its full source", () => {
  const body = `<!doctype html><html><body><h1>验证页面</h1>${"details\n".repeat(20000)}<script>alert(1)</script></body></html>`;
  const error = new ApiPageError("https://api.example.com", true, true, body);

  expect(showApiPageError(error)).toBe(true);
  const modal = showModal.mock.calls[0][0];
  expect(modal.defaultMax).toBe(true);
  render(modal.children);

  const preview = screen.getByTitle(text.Preview);
  expect(preview.getAttribute("srcdoc")).toBe(body);
  expect(preview.getAttribute("sandbox")).toBe("");
  expect(preview.getAttribute("referrerpolicy")).toBe("no-referrer");
  const source = screen.getByLabelText<HTMLTextAreaElement>(text.Source);
  expect(source.value).toBe(body);
  expect(source.readOnly).toBe(true);
  const actions = modal.actions;
  actions[0].props.onClick();
  expect(copyToClipboard).toHaveBeenCalledWith(body);
  expect(screen.getByRole("link").getAttribute("href")).toBe(error.site);
});

test.each([
  ["", text.EmptyBody],
  [undefined, text.ReadFailed],
])("explains when response content is unavailable (%s)", (body, message) => {
  showApiPageError(new ApiPageError(undefined, false, false, body));
  render(showModal.mock.calls[0][0].children);

  expect(screen.getByText(message!)).toBeTruthy();
  expect(screen.queryByTitle(text.Preview)).toBeNull();
});

test("does not open a page preview for unrelated errors", () => {
  expect(showApiPageError(new Error("Network error"))).toBe(false);
  expect(showModal).not.toHaveBeenCalled();
});
