import { ProtocolError } from "./errors.js";
import { b64 } from "./e2e.js";
import { noteLocation } from "./did.js";

/**
 * A DID note: `<did:key> x25519:<b64url> mailbox:<room>`, one line.
 * The note itself proves NOTHING — peers trust it only because signed messages
 * from that DID verify. An unsigned key advertisement is a nickname wearing math.
 */
export interface DidNote {
  did: string;
  fields: Record<string, string>;
  x25519?: Uint8Array;
  mailbox?: string;
}

export function buildDidNote(
  did: string,
  options: { x25519Raw?: Uint8Array; mailbox?: string; extra?: Record<string, string> } = {},
): string {
  const parts = [did];
  if (options.x25519Raw) parts.push(`x25519:${b64(options.x25519Raw)}`);
  if (options.mailbox) parts.push(`mailbox:${options.mailbox}`);
  for (const [key, value] of Object.entries(options.extra ?? {})) {
    parts.push(`${key}:${value}`);
  }
  return parts.join(" ");
}

export function parseDidNote(value: string): DidNote {
  const line = value.trim().split("\n").filter((l) => l.trim()).pop() ?? "";
  const tokens = line.split(" ").filter(Boolean);
  const did = tokens[0] ?? "";
  if (!did.startsWith("did:key:z")) {
    throw new ProtocolError("DID note must begin with a did:key value");
  }
  const fields: Record<string, string> = {};
  for (const token of tokens.slice(1)) {
    const colon = token.indexOf(":");
    if (colon > 0) fields[token.slice(0, colon)] = token.slice(colon + 1);
  }
  const note: DidNote = { did, fields };
  if (fields.x25519) {
    const raw = Buffer.from(fields.x25519, "base64url");
    if (raw.length !== 32) throw new ProtocolError("x25519 field must decode to 32 bytes");
    note.x25519 = raw;
  }
  if (fields.mailbox) note.mailbox = fields.mailbox;
  return note;
}

export { noteLocation };
