import { useEffect } from "react";
import { getClientApi, MultimodalContent, RequestMessage } from "../client/api";
import { ServiceProvider } from "../constant";
import Locale from "../locales";
import { ModelCaps, useAppConfig } from "../store/config";
import { useAccessStore } from "../store/access";
import { getClientConfig } from "../config/client";
import { getAllModels, useAllModels } from "./hooks";

// image/audio/embedding models can't answer a chat request, don't test them
const NON_CHAT_MODEL =
  /dall-e|tts|whisper|embed|realtime|moderation|image|audio|transcribe/i;

const TEST_NUMBER = "4827";
const TEST_WORD = "PELICAN";

export function capsKey(model: string, providerName?: string) {
  return `${model}@${providerName}`;
}

function setCaps(key: string, caps: ModelCaps | undefined) {
  useAppConfig.getState().update((config) => {
    config.modelCaps = { ...config.modelCaps };
    if (caps) config.modelCaps[key] = caps;
    else delete config.modelCaps[key];
  });
}

// one non-streaming request through the normal client, resolves with the reply text
export function askModel(
  model: string,
  providerName: string,
  content: RequestMessage["content"],
) {
  return new Promise<string>((resolve, reject) => {
    getClientApi(providerName as ServiceProvider).llm.chat({
      messages: [{ role: "user", content }],
      config: { model, providerName, stream: false },
      onFinish(message, res) {
        if (res?.ok === false) {
          reject(new Error(`${res.status} ${message ?? ""}`));
        } else {
          resolve(message ?? "");
        }
      },
      onError: reject,
    });
  });
}

// a one page pdf with a single line of text
export function buildTestPdf(text: string) {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((obj, i) => {
    const offset = pdf.length;
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
    return offset;
  });
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${
      objects.length + 1
    } /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return `data:application/pdf;base64,${btoa(pdf)}`;
}

function buildTestImage(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 240;
  canvas.height = 100;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#000";
  ctx.font = "bold 64px sans-serif";
  ctx.fillText(text, 30, 75);
  return canvas.toDataURL("image/png");
}

// replies are null when the request itself failed
export function capsFromReplies(
  image: string | null,
  pdf: string | null,
  plain: string | null,
): ModelCaps {
  // both attachment requests failed and so did plain text: the model can't be reached
  if (image === null && pdf === null && plain === null) {
    return { status: "failed" };
  }
  return {
    status: "done",
    vision: !!image?.includes(TEST_NUMBER),
    pdf: !!pdf?.toUpperCase().includes(TEST_WORD),
  };
}

export async function testModel(model: string, providerName: string) {
  const key = capsKey(model, providerName);
  // "testing" makes the client send attachments to this model whatever it is
  setCaps(key, { status: "testing" });
  const tryAsk = (content: RequestMessage["content"]) =>
    askModel(model, providerName, content).catch(() => null);

  const image = await tryAsk([
    {
      type: "text",
      text: "Reply with only the number shown in the image.",
    },
    { type: "image_url", image_url: { url: buildTestImage(TEST_NUMBER) } },
  ]);
  const pdf = await tryAsk([
    {
      type: "text",
      text: "Reply with only the code word written in the attached document.",
    },
    {
      type: "file",
      file: {
        filename: "test.pdf",
        file_data: buildTestPdf(`The code word is ${TEST_WORD}`),
      },
    },
  ] as MultimodalContent[]);
  const plain =
    image === null && pdf === null ? await tryAsk("Reply with OK.") : "";

  setCaps(key, capsFromReplies(image, pdf, plain));
}

const queue: [string, string][] = [];
const queued = new Set<string>();
let running = false;

async function runQueue() {
  if (running) return;
  running = true;
  while (queue.length > 0) {
    const [model, providerName] = queue.shift()!;
    try {
      await testModel(model, providerName);
    } finally {
      queued.delete(capsKey(model, providerName));
    }
  }
  running = false;
}

export function queueModelTest(model: string, providerName: string) {
  const key = capsKey(model, providerName);
  if (queued.has(key) || NON_CHAT_MODEL.test(model)) return;
  queued.add(key);
  queue.push([model, providerName]);
  runQueue();
}

// test every enabled model the first time it shows up, e.g. after it is added or renamed.
// "testing" left over from a closed tab means the test never finished, so it runs again
export function useModelCapsTesting() {
  const models = useAllModels();
  // stores load from indexeddb asynchronously, before that every model looks untested.
  // the site config decides which built-in models are enabled, the app build has none
  const configLoaded = useAppConfig((s) => s._hasHydrated);
  const accessLoaded = useAccessStore(
    (s) =>
      s._hasHydrated &&
      (s.serverConfigLoaded || getClientConfig()?.buildMode === "export"),
  );
  useEffect(() => {
    if (!configLoaded || !accessLoaded) return;
    const caps = useAppConfig.getState().modelCaps ?? {};
    for (const m of models) {
      const providerName = m.provider?.providerName ?? "";
      const status = caps[capsKey(m.name, providerName)]?.status;
      if (m.available && (!status || status === "testing")) {
        queueModelTest(m.name, providerName);
      }
    }
  }, [models, configLoaded, accessLoaded]);
}

// tags shown next to a model, e.g. "Images · PDF"
export function capsLabel(model: string, providerName?: string) {
  if (NON_CHAT_MODEL.test(model)) return "";
  const caps =
    useAppConfig.getState().modelCaps?.[capsKey(model, providerName)];
  const L = Locale.Settings.Channel.Caps;
  if (!caps) return L.Untested;
  if (caps.status === "testing") return L.Testing;
  if (caps.status === "failed") return L.Failed;
  const tags = [caps.vision && L.Vision, caps.pdf && L.Pdf].filter((t) => t);
  return tags.length > 0 ? tags.join(" · ") : L.TextOnly;
}

// model used to describe images for models that can't see them
export function getDescribeModel(): [string, string] | undefined {
  const { describeModel, describeProviderName, modelCaps } =
    useAppConfig.getState();
  if (describeModel) return [describeModel, describeProviderName];
  // first enabled model that passed the image test
  const model = getAllModels().find(
    (m) =>
      m.available &&
      modelCaps?.[capsKey(m.name, m.provider?.providerName)]?.vision,
  );
  return model && [model.name, model.provider?.providerName ?? ""];
}
