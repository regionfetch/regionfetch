# regionfetch

TypeScript client for [Region Fetch](https://regionfetch.dev) — paid
geo-targeted web retrieval with signed Ed25519 receipts.

> **Pre-release.** Not yet published to npm. Build from source:
> <https://github.com/regionfetch/regionfetch>

```bash
npm install regionfetch
```

Node 20.11+. ESM only. The core client has **zero runtime dependencies**;
`@x402/core`, `@x402/evm`, and `viem` are optional peers needed only for the
built-in wallet provider.

## Usage

```ts
import { RegionFetchClient } from "regionfetch";
import { createX402PaymentProvider } from "regionfetch/x402";

const client = new RegionFetchClient({
  paymentProvider: await createX402PaymentProvider({
    privateKey: process.env.WALLET_KEY,
    maxAmountPerPayment: "$0.10",
  }),
});

const result = await client.fetchUrl({
  url: "https://example.com/pricing",
  country: "DE",
  mode: "browser",
});

const verification = await client.verifyReceipt(result.receipt, {
  responseBody: result.data.body,
});
```

## API

| Method | Purpose |
| --- | --- |
| `fetchUrl(input, options?)` | Execute one paid regional fetch |
| `getRequest(requestId, options?)` | Recover a terminal result or poll a request in flight |
| `getAttestationKey(options?)` | The deployment's active Ed25519 verification key |
| `verifyReceipt(receipt, options?)` | Verify signature, payload, fields, body hash, and key |
| `health(options?)` | Liveness only |

Subpath exports: `regionfetch/verify` (Node-only verification),
`regionfetch/x402` (the wallet provider), `regionfetch/types`.

## Payment

The deployment speaks **x402 v2**. The unscoped `x402` and `x402-fetch` packages
are v1 and cannot pay it — install the scoped `@x402/*` packages at `2.24.x`.

`paymentProvider` is a one-method interface, so any wallet works:

```ts
const paymentProvider = {
  async createPayment({ paymentRequired, resourceUrl }) {
    return myWallet.authorize(paymentRequired, resourceUrl);
  },
};
```

One authorization funds one request. A single `fetchUrl` call never creates a
second payment.

## Countries and modes

`US`, `DE`, `JP`, `BR`, `IN` — validated locally before any payment, because the
deployment's payment gate runs ahead of its body validation.

`http` (default) for a lightweight proxied GET; `browser` for a rendered page.

Full documentation: <https://github.com/regionfetch/regionfetch>

MIT
