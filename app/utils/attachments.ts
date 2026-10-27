import { MultimodalContent, RequestMessage } from "../client/api";
import { isFileModel, isVisionModel } from "../utils";
import { askModel, getDescribeModel } from "./model-caps";

const DESCRIBE_PROMPT =
  "Describe this image in detail for someone who cannot see it. Transcribe any text in it exactly. Reply with the description only.";

// the description is saved on the image so it is only requested once
async function describeImage(
  image: NonNullable<MultimodalContent["image_url"]>,
) {
  if (image.description) return image.description;
  const describer = getDescribeModel();
  if (!describer)
    return "[no vision model is available to describe this image]";
  try {
    image.description = await askModel(describer[0], describer[1], [
      { type: "text", text: DESCRIBE_PROMPT },
      { type: "image_url", image_url: { url: image.url } },
    ]);
    return image.description;
  } catch (e) {
    console.error("[Attachments] failed to describe image", e);
    return "[the image could not be described]";
  }
}

// turn attachments the model can't take into text: images become descriptions,
// files become their extracted text. supported attachments are kept as they are
export async function prepareAttachments<T extends RequestMessage>(
  messages: T[],
  model: string,
  providerName: string,
): Promise<T[]> {
  const vision = isVisionModel(model, providerName);
  const pdf = isFileModel(model, providerName);

  const result: T[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      result.push(m);
      continue;
    }
    const texts: string[] = [];
    const parts: MultimodalContent[] = [];
    for (const part of m.content) {
      if (part.type === "text") {
        texts.push(part.text ?? "");
      } else if (part.type === "image_url" && part.image_url) {
        if (vision) parts.push(part);
        else
          texts.push(
            `<image>\n${await describeImage(part.image_url)}\n</image>`,
          );
      } else if (part.type === "file" && part.file) {
        if (pdf && part.file.file_data) parts.push(part);
        else
          texts.push(
            `<file name="${part.file.filename}">\n${
              part.file.text || "[no text could be extracted from this file]"
            }\n</file>`,
          );
      }
    }
    const text = texts.filter((t) => t).join("\n\n");
    result.push({
      ...m,
      content: parts.length > 0 ? [{ type: "text", text }, ...parts] : text,
    });
  }
  return result;
}
