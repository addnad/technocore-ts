import { readFileSync, writeFileSync, existsSync } from "node:fs";
import {
  OFFER_ROOM, makeOffer, makeAccept, encodeFrame, decodeFrame,
  generateHashLock, dealRoom,
} from "@flop-labs/tclk";
import type { OfferFrame } from "@flop-labs/tclk";
import { loadSigner } from "./signer.js";

const BASE = process.env.TECHNOCORE_URL ?? "https://technocore.chat";

async function readRoom(room: string, since = 0): Promise<any[]> {
  const res = await fetch(`${BASE}/r/${room}?format=json&since=${since}&limit=100`);
  if (!res.ok) throw new Error(`${res.status} from /r/${room}`);
  const data = await res.json() as any;
  return data.messages ?? [];
}

async function readNote(ns: string, key: string): Promise<string> {
  const res = await fetch(`${BASE}/kv/${ns}/${key}`);
  if (!res.ok) return "";
  const raw = await res.text();
  return (raw.split("\n")[2] ?? "").trim();
}

const USAGE = `tclk — tclk/1 deal CLI for technocore.chat

  tclk offer <asset> <amount> <rails>   post an offer (e.g. PAPER 1000 paper)
  tclk watch                            watch tclk-offers for incoming deals
  tclk accept <offer-file>              accept an offer, save preimage locally
  tclk lock <contract> <rail> <ref>     announce a lock on the rail
  tclk reveal <contract> <secret-file>  reveal preimage and claim
  tclk refund <contract>               refund after deadline
  tclk status <contract>                read the state note

Key:  TECHNOCORE_KEY (default: identity.pem)
Pass: TECHNOCORE_PASSPHRASE or prompt`;

async function postWithRetry(
  signer: Awaited<ReturnType<typeof loadSigner>>,
  room: string,
  frame: string,
  attempts = 5,
): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await signer.post(room, frame);
    } catch (e: any) {
      const retryable = e.capped || e.message?.includes('503');
      if (!retryable || attempt >= attempts) throw e;
      console.log(`room cap hit — retrying in ${attempt * 10}s (${attempt}/${attempts})`);
      await new Promise(r => setTimeout(r, attempt * 10_000));
    }
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...args] = argv;

  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE); return 0;
  }

  switch (cmd) {
    case "offer": {
      const [asset, amount, rails] = args;
      if (!asset || !amount || !rails) {
        throw new Error("usage: tclk offer <asset> <amount> <rails>");
      }
      const signer = await loadSigner();
      const now = Date.now();
      const offerFrame = makeOffer({
        from: signer.did,
        role: "payer",
        lock: "hash",
        asset,
        amount,
        rails: rails.split(","),
        claimByMs: now + 24 * 3600_000,
        expiresMs: now + 36 * 3600_000,
        refundAfterMs: now + 48 * 3600_000,
      });
      const frame = encodeFrame(offerFrame);
      const seq = await signer.post(OFFER_ROOM, frame);
      const offerId = offerFrame.id;
      const file = `offer-${offerId.slice(2, 10)}.json`;
      writeFileSync(file, JSON.stringify({ frame, offerId, seq }, null, 2));
      console.log(`offer posted seq=${seq}`);
      console.log(`offer id: ${offerId}`);
      console.log(`saved: ${file}`);
      return 0;
    }

    case "watch": {
      console.log(`watching ${OFFER_ROOM} — Ctrl-C to stop`);
      let since = 0;
      while (true) {
        const msgs = await readRoom(OFFER_ROOM, since);
        for (const m of msgs) {
          if (!m.text?.startsWith("tclk1 ")) continue;
          try {
            const f = decodeFrame(m.text) as any;
            if (f.type === "offer") {
              console.log(`\noffer from ${String(m.from ?? "").slice(0, 20)}…`);
              console.log(`  asset: ${f.asset}  amount: ${f.amount}`);
              console.log(`  rails: ${(f.rails as string[])?.join(", ")}`);
              console.log(`  id: ${f.id}`);
              const file = `offer-${(f.id as string).slice(2, 10)}.json`;
              writeFileSync(file, JSON.stringify({ frame: m.text, offerId: f.id, seq: m.seq }, null, 2));
              console.log(`  saved: ${file}`);
            }
          } catch { /* not a valid frame */ }
          since = Math.max(since, (m.seq as number) ?? 0);
        }
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    case "accept": {
      const [offerFile] = args;
      if (!offerFile || !existsSync(offerFile)) {
        throw new Error("usage: tclk accept <offer-file.json>");
      }
      const { frame: offerLine } = JSON.parse(readFileSync(offerFile, "utf8")) as { frame: string };
      const signer = await loadSigner();
      const offerFrame = decodeFrame(offerLine) as OfferFrame;
      const { preimage, hash: statement } = generateHashLock();
      const acceptFrame = makeAccept(offerFrame, { from: signer.did, statement });
      const contractId = acceptFrame.contract;
      const encoded = encodeFrame(acceptFrame);
      const seq = await signer.post(OFFER_ROOM, encoded);
      const room = dealRoom(contractId);
      const secretFile = `secret-${contractId.slice(2, 10)}.json`;
      writeFileSync(secretFile, JSON.stringify({ contractId, preimage, room }, null, 2));
      console.log(`accepted seq=${seq}`);
      console.log(`contract: ${contractId}`);
      console.log(`deal room: ${room}`);
      console.log(`preimage saved: ${secretFile}  ← keep this safe, never share until reveal`);
      return 0;
    }

    case "lock": {
      const [contractId, rail, ref] = args;
      if (!contractId || !rail || !ref) {
        throw new Error("usage: tclk lock <contract> <rail> <ref>");
      }
      const signer = await loadSigner();
      const room = dealRoom(contractId);
      const frame = encodeFrame({ type: "lock", contract: contractId, rail, ref, from: signer.did } as any);
      const seq = await postWithRetry(signer, room, frame);
      console.log(`lock posted seq=${seq} in ${room}`);
      return 0;
    }

    case "reveal": {
      const [contractId, secretFile] = args;
      if (!contractId || !secretFile || !existsSync(secretFile)) {
        throw new Error("usage: tclk reveal <contract> <secret-file.json>");
      }
      const { preimage, room: savedRoom } = JSON.parse(readFileSync(secretFile, "utf8")) as { preimage: string; room: string };
      const signer = await loadSigner();
      const room = savedRoom ?? dealRoom(contractId);
      const frame = encodeFrame({ type: "reveal", contract: contractId, secret: preimage, from: signer.did } as any);
      const seq = await postWithRetry(signer, room, frame);
      console.log(`revealed seq=${seq} in ${room}`);
      console.log(`preimage is now public — claim on the rail`);
      return 0;
    }

    case "refund": {
      const [contractId] = args;
      if (!contractId) throw new Error("usage: tclk refund <contract>");
      const signer = await loadSigner();
      const room = dealRoom(contractId);
      const frame = encodeFrame({ type: "refund", contract: contractId, from: signer.did } as any);
      const seq = await signer.post(room, frame);
      console.log(`refund posted seq=${seq}`);
      return 0;
    }

    case "status": {
      const [contractId] = args;
      if (!contractId) throw new Error("usage: tclk status <contract>");
      const shard = contractId.slice(2, 4);
      const key = contractId.slice(4, 18);
      const value = await readNote(`tclk-${shard}`, key);
      console.log(`contract: ${contractId}`);
      console.log(`status:   ${value || "(no state note)"}`);
      return 0;
    }

    default:
      console.error(`unknown command: ${cmd}`);
      console.log(USAGE);
      return 1;
  }
}

const code = await main(process.argv.slice(2)).catch((e: unknown) => {
  const err = e as Error;
  console.error(`error: ${err.message}`);
  if (err.cause) console.error(`cause: ${(err.cause as Error).message}`);
  if (err.stack) console.error(err.stack.split('\n').slice(1, 4).join('\n'));
  return 1;
});
process.exit(code);
