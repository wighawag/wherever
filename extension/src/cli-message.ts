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

/**
 * The event kenning's pi extension listens for on a session's `pi.events` bus
 * (kenning D22, ADR 0003; wherever ADR 0023): emitted right before a human's
 * text is sent into the session, so kenning records that turn as the human's
 * own words. The string is a contract with kenning (`HUMAN_INPUT_EVENT` in
 * kenning's `host.ts`); server/test/kenning-human-input.test.ts pins it.
 */
export const KENNING_HUMAN_INPUT_EVENT = "kenning:human-input";

/**
 * The kenning mark for a server `cli_message`, or null. The server sets
 * `humanInput: {channel}` only for a send a human typed (web, Telegram), never
 * for a scheduled job; anything else (absent, an unknown channel) marks nothing.
 * The text is the message itself: what pi's `input` event will carry, since
 * `sendUserMessage` joins the content's text parts (there is one).
 */
export function cliHumanInputMark(msg: { message: string; humanInput?: unknown }): { text: string; channel: "web" | "telegram" } | null {
  const channel = (msg.humanInput as { channel?: unknown } | null | undefined)?.channel;
  if (channel !== "web" && channel !== "telegram") return null;
  if (typeof msg.message !== "string") return null;
  return { text: msg.message, channel };
}
