import { unzipSync, strFromU8 } from "fflate";

// long spreadsheets and documents would blow past any context window
export const MAX_FILE_TEXT_CHARS = 200000;

const TEXT_EXTENSIONS = [
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "log", "html", "htm", "css", "scss", "js", "jsx",
  "ts", "tsx", "mjs", "cjs", "py", "ipynb", "java", "kt", "c", "h", "cpp", "hpp",
  "cc", "cs", "go", "rs", "rb", "php", "swift", "m", "scala", "sh", "bash", "ps1",
  "bat", "sql", "r", "lua", "pl", "dart", "vue", "svelte", "tex", "env",
]; // prettier-ignore

const OFFICE_EXTENSIONS = ["docx", "pptx", "xlsx"];

export function fileExtension(name: string) {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function isPdfFile(file: File) {
  return file.type === "application/pdf" || fileExtension(file.name) === "pdf";
}

// files we can turn into text: pdf, office documents, plain text and code
export function isDocumentFile(file: File) {
  const ext = fileExtension(file.name);
  return (
    isPdfFile(file) ||
    OFFICE_EXTENSIONS.includes(ext) ||
    TEXT_EXTENSIONS.includes(ext) ||
    file.type.startsWith("text/")
  );
}

// value for <input accept>
export const DOCUMENT_ACCEPT = [
  ".pdf",
  ...OFFICE_EXTENSIONS.map((e) => `.${e}`),
  ...TEXT_EXTENSIONS.map((e) => `.${e}`),
  "text/*",
].join(",");

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

function decodeXml(s: string) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) =>
      String.fromCodePoint(parseInt(h, 16)),
    )
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n] ?? m);
}

// text of all <tag>...</tag> runs inside each paragraph, one paragraph per line
function paragraphs(xml: string, paragraphTag: string, runTag: string) {
  const runRe = new RegExp(`<${runTag}(?:\\s[^>]*)?>([^<]*)</${runTag}>`, "g");
  return xml
    .split(`</${paragraphTag}>`)
    .map((p) =>
      Array.from(p.replace(/<w:tab\/>/g, "<w:t>\t</w:t>").matchAll(runRe))
        .map((m) => decodeXml(m[1]))
        .join(""),
    )
    .filter((line) => line.trim())
    .join("\n");
}

// entries matching prefix + number + .xml, in numeric order
function numbered(files: Record<string, Uint8Array>, prefix: string) {
  const re = new RegExp(`^${prefix}(\\d+)\\.xml$`);
  return Object.keys(files)
    .map((name) => ({ name, n: Number(re.exec(name)?.[1]) }))
    .filter((f) => !isNaN(f.n))
    .sort((a, b) => a.n - b.n)
    .map((f) => strFromU8(files[f.name]));
}

function docxText(files: Record<string, Uint8Array>) {
  return paragraphs(strFromU8(files["word/document.xml"]), "w:p", "w:t");
}

function pptxText(files: Record<string, Uint8Array>) {
  return numbered(files, "ppt/slides/slide")
    .map((xml, i) => `## Slide ${i + 1}\n${paragraphs(xml, "a:p", "a:t")}`)
    .join("\n\n");
}

function xlsxText(files: Record<string, Uint8Array>) {
  const shared = Array.from(
    strFromU8(files["xl/sharedStrings.xml"] ?? new Uint8Array()).matchAll(
      /<si>([\s\S]*?)<\/si>/g,
    ),
  ).map((m) =>
    Array.from(m[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g))
      .map((t) => decodeXml(t[1]))
      .join(""),
  );
  const names = Array.from(
    strFromU8(files["xl/workbook.xml"]).matchAll(
      /<sheet\b[^>]*\bname="([^"]*)"/g,
    ),
  ).map((m) => decodeXml(m[1]));

  return numbered(files, "xl/worksheets/sheet")
    .map((xml, i) => {
      const rows = Array.from(xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g))
        .map((row) => {
          // empty cells are not stored, place each cell by its column letters
          const cells: string[] = [];
          for (const [, attrs, inner = ""] of row[1].matchAll(
            /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g,
          )) {
            const letters = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
            const col = letters
              ? Array.from(letters).reduce(
                  (n, c) => n * 26 + c.charCodeAt(0) - 64,
                  0,
                ) - 1
              : cells.length;
            const type = /\bt="(\w+)"/.exec(attrs)?.[1];
            const value = /<v>([^<]*)<\/v>/.exec(inner)?.[1] ?? "";
            cells[col] =
              type === "inlineStr"
                ? decodeXml(
                    /<t(?:\s[^>]*)?>([^<]*)<\/t>/.exec(inner)?.[1] ?? "",
                  )
                : type === "s"
                ? shared[Number(value)] ?? ""
                : decodeXml(value);
          }
          return Array.from(cells, (c) => c ?? "");
        })
        .filter((cells) => cells.some((c) => c))
        .map((cells) => cells.join("\t"));
      return `## Sheet: ${names[i] ?? i + 1}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

async function pdfText(data: Uint8Array) {
  const { extractText } = await import("unpdf");
  return (await extractText(data, { mergePages: true })).text;
}

// plain text of a document file, cut to MAX_FILE_TEXT_CHARS
export async function extractFileText(file: File) {
  const ext = fileExtension(file.name);
  let text: string;
  if (isPdfFile(file)) {
    text = await pdfText(new Uint8Array(await file.arrayBuffer()));
  } else if (OFFICE_EXTENSIONS.includes(ext)) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    text = { docx: docxText, pptx: pptxText, xlsx: xlsxText }[ext]!(files);
  } else {
    text = await file.text();
  }
  return text.length > MAX_FILE_TEXT_CHARS
    ? text.slice(0, MAX_FILE_TEXT_CHARS) + "\n[truncated]"
    : text;
}
