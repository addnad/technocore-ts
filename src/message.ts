import { ProtocolError } from "./errors.js";

export const MAX_MESSAGE_CHARS = 4096;
export const MAX_NOTE_BYTES = 8192;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Replace every invisible character with a space, exactly as the server does
 * before storage: C0/C1 controls (newline included), format characters,
 * zero-width joiners and bidi overrides. Signatures MUST cover the swept text,
 * because the swept bytes are what gets stored and later re-verified.
 */
export function sweepToSingleLine(text: string): string {
  return Array.from(text)
    .map((char) => {
      const code = char.codePointAt(0)!;
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return " ";
      if (code === 0x200b || code === 0x200c || code === 0x200d) return " ";
      if (code >= 0x2028 && code <= 0x202e) return " ";
      if (code >= 0x2060 && code <= 0x2064) return " ";
      if (code >= 0x206a && code <= 0x206f) return " ";
      if (code === 0xfeff) return " ";
      return char;
    })
    .join("");
}

export function validateName(value: string, label = "room"): string {
  if (!NAME_PATTERN.test(value)) {
    throw new ProtocolError(`${label} must match ^[a-z0-9][a-z0-9_-]{0,47}$`);
  }
  return value;
}

export function validateNonce(value: string | number | bigint): string {
  const nonce = typeof value === "string" ? value : value.toString();
  if (!/^[0-9]{1,19}$/.test(nonce)) {
    throw new ProtocolError("nonce must be 1-19 digits");
  }
  return nonce;
}

/** Millisecond clock, which satisfies the strictly-increasing nonce rule. */
export function nextNonce(): string {
  return Date.now().toString();
}

/**
 * Build the exact bytes a signature covers: `<room>|<nonce>|<text>` as UTF-8,
 * where text is post-sweep. Returns the swept text alongside, since that is
 * what must be sent.
 */
export function messagePayload(
  room: string,
  nonce: string | number | bigint,
  text: string,
): { room: string; nonce: string; text: string; payload: Buffer } {
  const validRoom = validateName(room);
  const validNonce = validateNonce(nonce);
  const swept = sweepToSingleLine(text);
  if (swept.length === 0) throw new ProtocolError("message text must not be empty");
  if (swept.length > MAX_MESSAGE_CHARS) {
    throw new ProtocolError(`message must be at most ${MAX_MESSAGE_CHARS} characters`);
  }
  return {
    room: validRoom,
    nonce: validNonce,
    text: swept,
    payload: Buffer.from(`${validRoom}|${validNonce}|${swept}`, "utf8"),
  };
}
