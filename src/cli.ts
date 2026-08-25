import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { Identity } from "./identity.js";
import { TechnocoreClient } from "./client.js";
import { noteLocation } from "./did.js";
import { buildDidNote } from "./note.js";
import { ProtocolError } from "./errors.js";
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
      const note = buildDidNote(identity.did, args[0] ? { mailbox: args[0] } : {});
      console.log(await client.writeNote(`did-${location.shard}`, location.key, note));
      console.log(location.path);
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
