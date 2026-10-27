/**
 * @jest-environment node
 */
import { strToU8, zipSync } from "fflate";
import { extractText } from "unpdf";
import { extractFileText, isDocumentFile } from "../app/utils/file-text";
import { buildTestPdf, capsFromReplies } from "../app/utils/model-caps";
import { prepareAttachments } from "../app/utils/attachments";
import { isFileModel, isVisionModel } from "../app/utils";
import { useAppConfig } from "../app/store/config";
import { getHeaders, RequestMessage } from "../app/client/api";
import { useAccessStore } from "../app/store/access";
import { ServiceProvider } from "../app/constant";

// node 18 (used in CI) has Blob but no global File
function makeFile(parts: BlobPart[], name: string) {
  return Object.assign(new Blob(parts), { name }) as File;
}

function officeFile(name: string, entries: Record<string, string>) {
  const zip = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([k, v]) => [k, strToU8(v)]),
    ),
  );
  return makeFile([zip], name);
}

describe("extractFileText", () => {
  test("reads docx paragraphs", async () => {
    const file = officeFile("a.docx", {
      "word/document.xml":
        "<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space=\"preserve\"> world</w:t></w:r></w:p><w:p><w:r><w:t>A &amp; B</w:t></w:r></w:p></w:body></w:document>",
    });
    expect(await extractFileText(file)).toBe("Hello world\nA & B");
  });

  test("reads pptx slides in order", async () => {
    const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
    const file = officeFile("a.pptx", {
      "ppt/slides/slide10.xml": slide("ten"),
      "ppt/slides/slide2.xml": slide("two"),
    });
    expect(await extractFileText(file)).toBe(
      "## Slide 1\ntwo\n\n## Slide 2\nten",
    );
  });

  test("reads xlsx cells by column, with shared strings", async () => {
    const file = officeFile("a.xlsx", {
      "xl/workbook.xml": '<workbook><sheets><sheet name="Data" sheetId="1"/></sheets></workbook>',
      "xl/sharedStrings.xml": "<sst><si><t>name</t></si><si><t>bob</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>',
    });
    expect(await extractFileText(file)).toBe(
      "## Sheet: Data\nname\t\t3\nbob\tx",
    );
  });

  test("reads plain text and code", async () => {
    expect(await extractFileText(makeFile(["print(1)"], "a.py"))).toBe(
      "print(1)",
    );
  });

  test("knows which files are documents", () => {
    expect(isDocumentFile(makeFile([""], "a.PDF"))).toBe(true);
    expect(isDocumentFile(makeFile([""], "a.xlsx"))).toBe(true);
    expect(isDocumentFile(makeFile([""], "a.ts"))).toBe(true);
    expect(isDocumentFile(makeFile([""], "a.exe"))).toBe(false);
  });
});

describe("model capability test", () => {
  test("test pdf is a valid pdf with the expected text", async () => {
    const url = buildTestPdf("The code word is PELICAN");
    const data = Buffer.from(url.split(",")[1], "base64");
    const { text } = await extractText(new Uint8Array(data), {
      mergePages: true,
    });
    expect(text).toContain("PELICAN");
  });

  test("replies decide capabilities", () => {
    expect(capsFromReplies("4827", "pelican", "")).toEqual({
      status: "done",
      vision: true,
      pdf: true,
    });
    // attachment ignored or rejected, but the model answers
    expect(capsFromReplies("I can't see images", null, "")).toEqual({
      status: "done",
      vision: false,
      pdf: false,
    });
    expect(capsFromReplies(null, null, "OK")).toEqual({
      status: "done",
      vision: false,
      pdf: false,
    });
    // nothing gets through
    expect(capsFromReplies(null, null, null)).toEqual({ status: "failed" });
  });

  test("tested capabilities override the name patterns", () => {
    useAppConfig.setState({
      modelCaps: {
        "my-proxy-model@MyChannel": { status: "done", vision: true, pdf: true },
        "gpt-4o@OpenAI": { status: "done", vision: false, pdf: false },
        "new-model@MyChannel": { status: "testing" },
      },
    });
    expect(isVisionModel("my-proxy-model", "MyChannel")).toBe(true);
    expect(isFileModel("my-proxy-model", "MyChannel")).toBe(true);
    expect(isVisionModel("gpt-4o", "OpenAI")).toBe(false);
    expect(isFileModel("gpt-4o", "OpenAI")).toBe(false);
    // under test, attachments are let through so the test reaches the model
    expect(isVisionModel("new-model", "MyChannel")).toBe(true);
    // untested falls back to the name patterns
    expect(isVisionModel("gpt-4.1", "OpenAI")).toBe(true);
  });
});

describe("getHeaders", () => {
  test("uses the requested provider's key, not the current chat's", () => {
    // the current chat uses OpenAI (the default session)
    useAccessStore.setState({
      openaiApiKey: "sk-openai",
      anthropicApiKey: "sk-anthropic",
    });
    const headers = getHeaders(false, ServiceProvider.Anthropic);
    expect(headers["x-api-key"]).toBe("sk-anthropic");
    expect(headers["Authorization"]).toBeUndefined();
    expect(getHeaders()["Authorization"]).toBe("Bearer sk-openai");
  });
});

describe("prepareAttachments", () => {
  const pdf = {
    filename: "a.pdf",
    file_data: "data:application/pdf;base64,AA",
    text: "pdf text",
  };
  const messages: RequestMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AA", description: "a cat" },
        },
        { type: "file", file: pdf },
        { type: "file", file: { filename: "b.csv", text: "x,y" } },
      ],
    },
  ];

  beforeEach(() => {
    useAppConfig.setState({
      modelCaps: {
        "text-model@C": { status: "done", vision: false, pdf: false },
        "full-model@C": { status: "done", vision: true, pdf: true },
      },
    });
  });

  test("text-only models get descriptions and extracted text", async () => {
    const [m] = await prepareAttachments(messages, "text-model", "C");
    expect(m.content).toBe(
      'look\n\n<image>\na cat\n</image>\n\n<file name="a.pdf">\npdf text\n</file>\n\n<file name="b.csv">\nx,y\n</file>',
    );
  });

  test("capable models keep images and pdfs, other files become text", async () => {
    const [m] = await prepareAttachments(messages, "full-model", "C");
    expect(m.content).toEqual([
      { type: "text", text: 'look\n\n<file name="b.csv">\nx,y\n</file>' },
      (messages[0].content as any)[1],
      { type: "file", file: pdf },
    ]);
  });
});
