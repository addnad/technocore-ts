import { Identity } from "./identity.js";
import { validateName, validateNonce, sweepToSingleLine } from "./message.js";
import { ProtocolError } from "./errors.js";

/**
 * Signed note writes cover `<ns>|<key>|<nonce>|<value>` — a DIFFERENT payload
 * shape from room messages (`<room>|<nonce>|<text>`). Only the room-owners and
 * room-allow namespaces accept them; every other note is world-writable.
 */
export function notePayload(
  namespace: string,
  key: string,
  nonce: string | number,
  value: string,
): { namespace: string; key: string; nonce: string; value: string; payload: Buffer } {
  const ns = validateName(namespace, "namespace");
  const noteKey = validateName(key, "key");
  const validNonce = validateNonce(nonce);
  const swept = sweepToSingleLine(value);
  return {
    namespace: ns,
    key: noteKey,
    nonce: validNonce,
    value: swept,
    payload: Buffer.from(`${ns}|${noteKey}|${validNonce}|${swept}`, "utf8"),
  };
}

/** Only d- rooms are ownable; lobby and meta never are. */
export function validateOwnableRoom(room: string): string {
  const name = validateName(room);
  if (!name.startsWith("d-")) {
    throw new ProtocolError("only d- rooms are ownable");
  }
  return name;
}

/**
 * Claim ownership at creation. The initial claim must be signed by the same
 * did:key being stored, proving the claimant holds it. `if_absent=1` makes it
 * a race the first writer wins; 409 means you lost.
 */
export function buildClaimUrl(
  identity: Identity,
  room: string,
  nonce: string | number,
): string {
  const name = validateOwnableRoom(room);
  const built = notePayload("room-owners", name, nonce, identity.did);
  const sig = identity.sign(built.payload);
  return (
    `/kv/room-owners/${name}/set-signed/${identity.did}/${sig}/${built.nonce}/` +
    `${encodeURIComponent(identity.did)}?if_absent=1`
  );
}

/**
 * Write the allow-list. Owner's key only, and the nonce must exceed the claim
 * nonce — room-owners and room-allow share /kv/room-nonce/<room> as one counter.
 */
export function buildAllowUrl(
  identity: Identity,
  room: string,
  nonce: string | number,
  allowedDids: string[],
): string {
  const name = validateOwnableRoom(room);
  for (const did of allowedDids) {
    if (!did.startsWith("did:key:z")) {
      throw new ProtocolError(`allow-list entries must be did:key values: ${did}`);
    }
  }
  const value = allowedDids.join(" ");
  const built = notePayload("room-allow", name, nonce, value);
  const sig = identity.sign(built.payload);
  return (
    `/kv/room-allow/${name}/set-signed/${identity.did}/${sig}/${built.nonce}/` +
    `${encodeURIComponent(value)}`
  );
}
