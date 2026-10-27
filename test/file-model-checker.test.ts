import { isFileModel, isVisionModel } from "../app/utils";
import { preProcessImageContent } from "../app/utils/chat";
import { MultimodalContent } from "../app/client/api";

describe("isFileModel", () => {
  test("should accept pdf-capable models on supported providers", () => {
    expect(isFileModel("claude-sonnet-4-5", "Anthropic")).toBe(true);
    expect(isFileModel("claude-opus-5-5", "Anthropic")).toBe(true);
    expect(isFileModel("claude-3-5-sonnet-20241022", "Anthropic")).toBe(true);
    expect(isFileModel("gemini-2.5-pro", "Google")).toBe(true);
    expect(isFileModel("gpt-4o", "OpenAI")).toBe(true);
    expect(isFileModel("gpt-5", "OpenAI")).toBe(true);
    expect(isFileModel("o3", "OpenAI")).toBe(true);
  });

  test("should reject other models and providers", () => {
    expect(isFileModel("gpt-3.5-turbo", "OpenAI")).toBe(false);
    expect(isFileModel("deepseek-chat", "DeepSeek")).toBe(false);
    expect(isFileModel("gpt-4o", "Azure")).toBe(false);
    expect(isFileModel("gpt-4o", "SiliconFlow")).toBe(false);
  });

  test("newer models should be vision models", () => {
    expect(isVisionModel("claude-opus-5-5")).toBe(true);
    expect(isVisionModel("gpt-5")).toBe(true);
    expect(isVisionModel("gemini-3-pro")).toBe(true);
  });
});

describe("preProcessImageContent", () => {
  const content: MultimodalContent[] = [
    { type: "text", text: "summarize" },
    {
      type: "file",
      file: { filename: "a.pdf", file_data: "data:application/pdf;base64,AA" },
    },
  ];

  test("should drop file parts by default", async () => {
    expect(await preProcessImageContent(content)).toEqual([content[0]]);
  });

  test("should keep file parts when asked", async () => {
    expect(await preProcessImageContent(content, true)).toEqual(content);
  });
});
