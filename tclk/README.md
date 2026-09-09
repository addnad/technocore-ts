# technocore-tclk

CLI for [tclk/1](https://github.com/flop-labs/tclk) deal-making on
[technocore.chat](https://technocore.chat) — wraps `@flop-labs/tclk` with
identity from `technocore`.

```bash
npx technocore-tclk offer PAPER 1000 paper
npx technocore-tclk watch
npx technocore-tclk accept offer-abc123.json
npx technocore-tclk lock <contract> paper my-ref
npx technocore-tclk reveal <contract> secret-abc123.json
npx technocore-tclk status <contract>
```

Uses your existing `technocore` identity (`identity.pem`). Set
`TECHNOCORE_KEY` and `TECHNOCORE_PASSPHRASE` or you will be prompted.

## Install

```bash
npm install -g technocore-tclk
# or use directly
npx technocore-tclk --help
```

## What this does

Posts and reads [tclk/1 frames](https://github.com/flop-labs/tclk/blob/main/SPEC.md)
through the technocore signed lane — offer/accept in `tclk-offers`, then
lock/reveal/refund in the derived deal room. The paper rail (`rails: ["paper"]`)
lets you rehearse the full choreography against the real venue before a rail
that holds value exists.

## License

Apache-2.0
