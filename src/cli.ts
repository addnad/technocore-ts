import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { Identity } from "./identity.js";
import { TechnocoreClient } from "./client.js";
import { noteLocation } from "./did.js";
import { buildDidNote } from "./note.js";
import { ProtocolError } from "./errors.js";
import { lookupFootprint, footprintScore } from "./reputation.js";
import { loadStore, saveStore, rememberRoom, findRoom } from "./store.js";
import { parseDidNote } from "./note.js";
import {
  b64, buildDelivery, decryptLine, encryptLine, generateRoomKey,
  generateX25519, openDelivery, x25519PrivateFromRaw, unb64,
} from "./e2e.js";
import { randomBytes, createPublicKey } from "node:crypto";
import { loadX25519, rawFromX25519Public } from "./e2e.js";
import { NetworkError } from "./client.js";

const DEFAULT_KEY = "identity.pem";

/** Prompt without echoing. */
async function askSecret(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const stdout = process.stdout as NodeJS.WriteStream & { muted?: boolean };
  const write = stdout.write.bind(stdout);
  let muted = false;
  (stdout as { write: unknown }).write = (chunk: string, ...rest: unknown[]) =>
    muted && !chunk.includes("\n") ? true : (write as Function)(chunk, ...rest);
  process.stdout.write(prompt);
  muted = true;
  const answer = await rl.question("");
  muted = false;
  (stdout as { write: unknown }).write = write;
  process.stdout.write("\n");
  rl.close();
  return answer;
}

function keyPath(): string {
  return process.env.TECHNOCORE_KEY ?? DEFAULT_KEY;
}

async function loadIdentity(): Promise<Identity> {
  const path = keyPath();
  if (!existsSync(path)) {
    throw new ProtocolError(`no identity at ${path} — run: technocore init`);
  }
  const passphrase = process.env.TECHNOCORE_PASSPHRASE ?? (await askSecret("Passphrase: "));
  return Identity.load(path, passphrase);
}

const USAGE = `technocore — client for the technocore.chat signed lane

  technocore init                       create an encrypted did:key identity
  technocore did                        print your DID
  technocore publish [mailbox]          publish your DID note (sharded path)
  technocore say <room> <text>          post a signed message
  technocore read <room> [limit]        read a room
  technocore follow <room>              stream a room until Ctrl-C
  technocore claim <d-room>             claim an ownable room
  technocore allow <d-room> <did...>    set the owner-only allow-list
  technocore note <ns> <key> [value]    read or write a note
  technocore whois <did>                what a DID has actually published

  technocore mailbox                    set up private messaging (run once)
  technocore import-key <file>          adopt an existing X25519 key file
  technocore send <did> <message>       send a private message
  technocore inbox                      check for private messages
  technocore chat <room> [message]      read or write in a private room

Key path defaults to ./identity.pem; override with TECHNOCORE_KEY.
Set TECHNOCORE_PASSPHRASE to skip the prompt (avoid in shared shells).`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const client = new TechnocoreClient();

  switch (command) {
    case "init": {
      const path = keyPath();
      if (existsSync(path)) throw new ProtocolError(`refusing to overwrite ${path}`);
      const fromEnv = process.env.TECHNOCORE_PASSPHRASE;
      const passphrase = fromEnv ?? (await askSecret("New passphrase (12+ characters): "));
      if (!fromEnv && passphrase !== (await askSecret("Confirm passphrase: "))) {
        throw new ProtocolError("passphrases do not match");
      }
      const identity = Identity.generate();
      identity.save(path, passphrase);
      console.log(identity.did);
      console.log(`\nSaved to ${path}. Back it up — this key is not recoverable.`);
      return 0;
    }
    case "did":
      console.log((await loadIdentity()).did);
      return 0;
    case "publish": {
      const identity = await loadIdentity();
      const location = noteLocation(identity.did);

      // Notes are last-write-wins, so republishing must MERGE. Overwriting here
      // would silently drop an x25519 key or mailbox set up by `mailbox`, and
      // take private messaging offline without telling anyone.
      let existing: Record<string, string> = {};
      let existingX25519: Uint8Array | undefined;
      let existingMailbox: string | undefined;
      try {
        const current = parseDidNote((await client.readNote(`did-${location.shard}`, location.key)).value);
        existing = { ...current.fields };
        existingX25519 = current.x25519;
        existingMailbox = current.mailbox;
        delete existing.x25519;
        delete existing.mailbox;
      } catch {
        // no note yet, or it does not parse — publish a fresh one
      }

      const note = buildDidNote(identity.did, {
        x25519Raw: existingX25519,
        mailbox: args[0] ?? existingMailbox,
        extra: existing,
      });
      console.log(await client.writeNote(`did-${location.shard}`, location.key, note));
      console.log(location.path);
      if (existingX25519) console.log("kept your encryption key and inbox");
      return 0;
    }
    case "say": {
      const [room, ...rest] = args;
      if (!room || rest.length === 0) throw new ProtocolError("usage: technocore say <room> <text>");
      const response = await client.say(await loadIdentity(), room, rest.join(" "));
      console.log(`seq=${response.posted!.seq} verified=${response.posted!.verified}`);
      return 0;
    }
    case "read": {
      const [room, limit] = args;
      if (!room) throw new ProtocolError("usage: technocore read <room> [limit]");
      const response = await client.read(room, { limit: limit ? Number(limit) : 20 });
      for (const message of response.messages) {
        const who = message.verified ? `<${message.from.slice(9, 17)}…>` : `<~${message.from}>`;
        console.log(`${message.seq}\t${message.verified ? "signed  " : "unsigned"}\t${who}\t${message.text}`);
      }
      return 0;
    }
    case "follow": {
      const [room] = args;
      if (!room) throw new ProtocolError("usage: technocore follow <room>");
      const controller = new AbortController();
      process.on("SIGINT", () => {
        controller.abort();
        process.stdout.write("\n");
        process.exit(0);
      });
      client.onGap = (expected, actual) =>
        console.error(`# gap: missed seq ${expected + 1}-${actual - 1} (ring dropped them)`);
      client.onRoomReset = (previous, tail) =>
        console.error(`# room was recreated (seq restarted; cursor ${previous} > tail ${tail}) — resuming from the start`);
      for await (const message of client.follow(room, { signal: controller.signal })) {
        const who = message.verified ? `<${message.from.slice(9, 17)}…>` : `<~${message.from}>`;
        console.log(`${message.seq}\t${message.verified ? "signed  " : "unsigned"}\t${who}\t${message.text}`);
      }
      return 0;
    }
    case "claim": {
      const [room] = args;
      if (!room) throw new ProtocolError("usage: technocore claim <d-room>");
      const identity = await loadIdentity();
      console.log(await client.claimRoom(identity, room, Date.now()));
      return 0;
    }
    case "allow": {
      const [room, ...dids] = args;
      if (!room || dids.length === 0) throw new ProtocolError("usage: technocore allow <d-room> <did...>");
      // room-owners and room-allow share one replay counter, so this nonce must
      // exceed the claim nonce. Read the counter rather than trusting the clock.
      let nonce = Date.now();
      try {
        const counter = Number((await client.readNote("room-nonce", room)).value.trim());
        if (Number.isFinite(counter) && counter >= nonce) nonce = counter + 1;
      } catch {
        // no counter yet — the clock is fine
      }
      console.log(await client.setAllowList(await loadIdentity(), room, nonce, dids));
      return 0;
    }
    case "note": {
      const [namespace, key, ...value] = args;
      if (!namespace || !key) throw new ProtocolError("usage: technocore note <ns> <key> [value]");
      if (value.length === 0) {
        console.log((await client.readNote(namespace, key)).value);
      } else {
        console.log(await client.writeNote(namespace, key, value.join(" ")));
      }
      return 0;
    }
    case "whois": {
      const [did] = args;
      if (!did?.startsWith("did:key:z")) throw new ProtocolError("usage: technocore whois <did:key:z...>");
      const footprint = await lookupFootprint(client, did);
      console.log(did);
      console.log(`  DID note        ${footprint.hasNote ? "yes" : "no"}`);
      console.log(`  encryption key  ${footprint.hasEncryptionKey ? "yes" : "no"}`);
      console.log(`  mailbox         ${footprint.note?.mailbox ?? "no"}`);
      console.log(`  contribution    ${footprint.hasContribution ? "yes" : "no"}`);
      console.log(`  footprint       ${footprintScore(footprint)}/5`);
      if (!footprint.hasNote) {
        console.log("\n  Nothing published. This proves nothing either way — a valid");
        console.log("  signature still means they hold the key. It only means they");
        console.log("  have not set up an identity note.");
      }
      return 0;
    }
    case "mailbox": {
      const passphrase = process.env.TECHNOCORE_PASSPHRASE ?? (await askSecret("Passphrase: "));
      const identity = Identity.load(keyPath(), passphrase);
      const storePath = process.env.TECHNOCORE_STORE ?? keyPath().replace(/\.pem$/, "") + ".store";
      const store = loadStore(storePath, passphrase);
      if (store.x25519 && store.mailbox) {
        console.log(`already set up\n  mailbox: ${store.mailbox}`);
        return 0;
      }
      // A published key with no local store means the key lives somewhere this
      // command cannot see. Minting a new one would orphan every message already
      // sent to the old inbox, so refuse and say how to recover.
      try {
        const loc = noteLocation(identity.did);
        const published = parseDidNote((await client.readNote(`did-${loc.shard}`, loc.key)).value);
        if (published.x25519) {
          console.error("error: your published note already advertises an encryption key,");
          console.error("but this machine has no matching store. Creating a new one would");
          console.error("make every message already sent to your inbox unreadable.");
          console.error("");
          console.error("  have the key file?   technocore import-key <file>");
          console.error("  lost it for good?    TECHNOCORE_FORCE_NEW_KEY=1 technocore mailbox");
          if (!process.env.TECHNOCORE_FORCE_NEW_KEY) return 1;
          console.error("\nTECHNOCORE_FORCE_NEW_KEY set — replacing the key.\n");
        }
      } catch {
        // no published note yet, which is the ordinary first-run case
      }
      const x = generateX25519();
      const mailbox = "mb-p-" + randomBytes(8).toString("hex");
      const rawPriv = x.privateKey.export({ type: "pkcs8", format: "der" }).subarray(16);
      saveStore(storePath, passphrase, {
        ...store,
        x25519: Buffer.from(rawPriv).toString("base64url"),
        mailbox,
      });
      const location = noteLocation(identity.did);
      const note = buildDidNote(identity.did, { x25519Raw: x.publicKeyRaw, mailbox });
      await client.writeNote(`did-${location.shard}`, location.key, note);
      console.log(`private messaging is on.\n  your inbox: ${mailbox}\n  published to: ${location.path}`);
      console.log(`\nOthers can now send you private messages using your ID.`);
      return 0;
    }
    case "send": {
      const [did, ...words] = args;
      if (!did?.startsWith("did:key:z") || words.length === 0) {
        throw new ProtocolError("usage: technocore send <did> <message>");
      }
      const passphrase = process.env.TECHNOCORE_PASSPHRASE ?? (await askSecret("Passphrase: "));
      const identity = Identity.load(keyPath(), passphrase);
      const storePath = process.env.TECHNOCORE_STORE ?? keyPath().replace(/\.pem$/, "") + ".store";
      const location = noteLocation(did);
      const note = parseDidNote((await client.readNote(`did-${location.shard}`, location.key)).value);
      if (!note.x25519 || !note.mailbox) {
        throw new ProtocolError("that ID has not set up private messaging");
      }
      // Reuse an existing room with this peer: only the first message needs a
      // new room, and the network's room namespace is capped globally.
      const existing = loadStore(storePath, passphrase).rooms.find((r) => r.peer === did);
      if (existing) {
        const identityForReply = Identity.load(keyPath(), passphrase);
        await client.sayWithRetry(
          identityForReply,
          existing.room,
          encryptLine(Buffer.from(existing.key, "base64url"), words.join(" ")),
          { onRetry: (a) => console.log(`retrying (${a})…`) },
        );
        console.log(`sent to your existing private room: ${existing.room}`);
        return 0;
      }
      const roomKey = generateRoomKey();
      const room = "p-" + randomBytes(10).toString("hex");
      const { line } = buildDelivery(note.x25519, roomKey, room);
      const onRetry = (attempt: number) =>
        console.log(`network is at its room limit; retrying (${attempt})…`);
      await client.sayWithRetry(identity, note.mailbox, line, { onRetry });
      await client.sayWithRetry(identity, room, encryptLine(roomKey, words.join(" ")), { onRetry });
      saveStore(storePath, passphrase, rememberRoom(loadStore(storePath, passphrase), {
        room, key: roomKey.toString("base64url"), peer: did, created: new Date().toISOString(),
      }));
      const mine = noteLocation(identity.did);
      await client.say(identity, "lobby", `mail for /kv/did-${location.shard}/${location.key} — from /kv/did-${mine.shard}/${mine.key}`);
      console.log(`sent. private room: ${room}`);
      console.log(`keep that name private — it is how the room is reached.`);
      return 0;
    }
    case "inbox": {
      const passphrase = process.env.TECHNOCORE_PASSPHRASE ?? (await askSecret("Passphrase: "));
      const storePath = process.env.TECHNOCORE_STORE ?? keyPath().replace(/\.pem$/, "") + ".store";
      const store = loadStore(storePath, passphrase);
      if (!store.mailbox || !store.x25519) {
        throw new ProtocolError("run: technocore mailbox");
      }
      const staticKey = x25519PrivateFromRaw(unb64(store.x25519));
      const room = await client.read(store.mailbox, { limit: 20 });
      let found = 0;
      let updated = store;
      for (const message of room.messages) {
        if (!message.text.startsWith("e2e1") || !message.verified) continue;
        try {
          const opened = openDelivery(staticKey, message.text);
          updated = rememberRoom(updated, {
            room: opened.roomName,
            key: opened.roomKey.toString("base64url"),
            peer: message.from,
            created: message.ts,
          });
          found++;
          console.log(`from ${message.from.slice(0, 21)}…`);
          console.log(`  private room: ${opened.roomName}`);
          console.log(`  read it:      technocore chat ${opened.roomName}`);
        } catch {
          console.log(`from ${message.from.slice(0, 21)}… (could not open — not addressed to your key)`);
        }
      }
      saveStore(storePath, passphrase, updated);
      if (found === 0) console.log("no new private messages.");
      return 0;
    }
    case "chat": {
      const [room, ...words] = args;
      if (!room) throw new ProtocolError("usage: technocore chat <room> [message]");
      const passphrase = process.env.TECHNOCORE_PASSPHRASE ?? (await askSecret("Passphrase: "));
      const storePath = process.env.TECHNOCORE_STORE ?? keyPath().replace(/\.pem$/, "") + ".store";
      const store = loadStore(storePath, passphrase);
      const entry = findRoom(store, room);
      if (!entry) throw new ProtocolError(`no key for ${room} — run: technocore inbox`);
      const roomKey = Buffer.from(entry.key, "base64url");
      if (words.length > 0) {
        const identity = Identity.load(keyPath(), passphrase);
        const posted = await client.say(identity, room, encryptLine(roomKey, words.join(" ")));
        console.log(`sent (seq=${posted.posted!.seq})`);
        return 0;
      }
      const conversation = await client.read(room, { limit: 20 });
      for (const message of conversation.messages) {
        try {
          console.log(`${message.from.slice(9, 17)}…  ${decryptLine(roomKey, message.text)}`);
        } catch {
          console.log(`${message.from.slice(9, 17)}…  (unreadable — different key)`);
        }
      }
      return 0;
    }
    case "import-key": {
      const [file] = args;
      if (!file) throw new ProtocolError("usage: technocore import-key <file>");
      const passphrase = process.env.TECHNOCORE_PASSPHRASE ?? (await askSecret("Passphrase: "));
      const identity = Identity.load(keyPath(), passphrase);
      const privateKey = loadX25519(file, passphrase);
      const publicRaw = rawFromX25519Public(createPublicKey(privateKey));

      const loc = noteLocation(identity.did);
      const published = parseDidNote((await client.readNote(`did-${loc.shard}`, loc.key)).value);
      if (!published.x25519) throw new ProtocolError("your note advertises no encryption key");
      if (Buffer.from(published.x25519).toString("base64url") !== b64(publicRaw)) {
        throw new ProtocolError("that key does not match the one in your published note");
      }
      if (!published.mailbox) throw new ProtocolError("your note advertises no mailbox");

      const storePath = process.env.TECHNOCORE_STORE ?? keyPath().replace(/\.pem$/, "") + ".store";
      const rawPriv = privateKey.export({ type: "pkcs8", format: "der" }).subarray(16);
      saveStore(storePath, passphrase, {
        ...loadStore(storePath, passphrase),
        x25519: Buffer.from(rawPriv).toString("base64url"),
        mailbox: published.mailbox,
      });
      console.log(`imported. your inbox: ${published.mailbox}`);
      console.log(`read it with: technocore inbox`);
      return 0;
    }
    default:
      console.log(USAGE);
      return command ? 1 : 0;
  }
}

const exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof ProtocolError || error instanceof NetworkError) {
    console.error(`error: ${error.message}`);
    return 1;
  }
  throw error;
});
process.exit(exitCode);
