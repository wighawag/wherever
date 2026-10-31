/**
 * What a server `cli_message` hands to `pi.sendUserMessage` in the bridged
 * terminal pi (task `pool-send-images`).
 *
 * Without images (no `images` key, an empty list, or nothing well-formed) it is
 * the message string itself, exactly as before. With images it is the content
 * array pi's `sendUserMessage` accepts: the text first, then each image, so the
 * terminal pi sends them to the model as image inputs (pi joins the text parts
 * and passes the images to `prompt()`, which normalizes and resizes them).
 * Malformed entries (not `{ type: "image", data, mimeType }` with string fields)
 * are dropped rather than handed to pi.
 */

export interface CliMessageImage {
  type: "image";
  data: string;
  mimeType: string;
}

export type CliMessageContent = string | Array<{ type: "text"; text: string } | CliMessageImage>;

function isImage(v: unknown): v is CliMessageImage {
  const o = v as Partial<CliMessageImage> | null;
  return !!o && o.type === "image" && typeof o.data === "string" && !!o.data && typeof o.mimeType === "string" && !!o.mimeType;
}

export function cliMessageContent(msg: { message: string; images?: unknown }): CliMessageContent {
  const images = Array.isArray(msg.images) ? msg.images.filter(isImage) : [];
  if (images.length === 0) return msg.message;
  return [
    { type: "text", text: msg.message },
    ...images.map((i): CliMessageImage => ({ type: "image", data: i.data, mimeType: i.mimeType })),
  ];
}
