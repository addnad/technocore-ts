import { ProtocolError } from "./errors.js";

export const MAX_MESSAGE_CHARS = 4096;
export const MAX_NOTE_BYTES = 8192;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;

/**
 * Replace every invisible character with a space and trim, exactly as the
 * server's clean_text does before storage. Signatures MUST cover the swept
 * text, because the swept bytes are what gets stored and later re-verified.
 *
 * The categories are named rather than enumerated so the set cannot be
 * incomplete: the server tests unicodedata.category(c) against
 * ("Cc","Cf","Cs","Co","Zl","Zp"), and this class is the same six.
 *
 * Two things here are load-bearing and easy to lose in review:
 *   - .trim() matches the server's trailing .strip(). Without it a stray
 *     newline or BOM at an edge becomes a space the server removes and this
 *     client does not, and the signature fails with a bare 403.
 *   - Zs stays OUT of the class. The server keeps Zs, so NBSP must survive.
 *     Do not add it because the constant is called INVISIBLE.
 *
 * The u flag matches by code point, so astral characters need no manual
 * surrogate handling and \p{Cs} still catches an unpaired surrogate.
 */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

export function sweepToSingleLine(text: string): string {
  return text.replace(INVISIBLE, " ").trim();
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

let lastNonce = 0;

/**
 * Strictly increasing nonce. The server requires the nonce to exceed the last
 * one it can see from this key, so a bare millisecond clock collides when two
 * messages are sent inside the same millisecond and the second is refused as a
 * replay.
 */
export function nextNonce(): string {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce.toString();
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
