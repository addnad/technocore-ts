import { TechnocoreClient } from "./client.js";
import { noteLocation } from "./did.js";
import { parseDidNote, type DidNote } from "./note.js";

/**
 * What a DID has actually done, beyond posting. Every field here costs the
 * holder real work to produce, which is what makes it a signal — unlike a
 * message, which costs one request.
 */
export interface Footprint {
  did: string;
  /** Published a DID note at the sharded path (or the legacy one). */
  hasNote: boolean;
  /** Advertised an X25519 key — they can do encrypted channels. */
  hasEncryptionKey: boolean;
  /** Advertised a mailbox others can write to. */
  hasMailbox: boolean;
  /** Published a signed contribution proof. */
  hasContribution: boolean;
  note?: DidNote;
}

export function footprintScore(footprint: Footprint): number {
  return (
    (footprint.hasNote ? 1 : 0) +
    (footprint.hasEncryptionKey ? 1 : 0) +
    (footprint.hasMailbox ? 1 : 0) +
    (footprint.hasContribution ? 2 : 0)
  );
}

/** Look up one DID's footprint. Two requests at most, both cached by the caller. */
export async function lookupFootprint(
  client: TechnocoreClient,
  did: string,
): Promise<Footprint> {
  const footprint: Footprint = {
    did,
    hasNote: false,
    hasEncryptionKey: false,
    hasMailbox: false,
    hasContribution: false,
  };

  const location = noteLocation(did);
  let raw: string | undefined;
  try {
    raw = (await client.readNote(`did-${location.shard}`, location.key)).value;
  } catch {
    try {
      raw = (await client.readNote("did", location.key.length === 14
        ? `${location.shard}${location.key}`
        : location.key)).value;
    } catch {
      return footprint;
    }
  }

  if (!raw?.trim()) return footprint;

  try {
    const note = parseDidNote(raw);
    footprint.hasNote = true;
    footprint.note = note;
    footprint.hasEncryptionKey = Boolean(note.x25519);
    footprint.hasMailbox = Boolean(note.mailbox);
    footprint.hasContribution = Object.keys(note.fields).some(
      (field) => field === "contribution" || field === "proof",
    );
  } catch {
    // A note that does not parse is not a note.
  }

  return footprint;
}
