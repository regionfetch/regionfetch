# Region Fetch

[![CI](https://github.com/regionfetch/regionfetch/actions/workflows/ci.yml/badge.svg)](https://github.com/regionfetch/regionfetch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen.svg)](https://nodejs.org)

> **Pre-release.** Neither package is published to npm yet, so the install
> commands below do not work today — build from source (see
> [Development](#development)). The hosted API at `regionfetch.dev` is live.

Fetch a public HTTPS URL as a visitor in a specific country would see it, and get
a signed receipt proving where the retrieval actually came from.

One request. One x402 payment. One Ed25519-signed attestation of the exit
country, supplier, final URL, and content hash.

This repository holds the public client packages:

| Package | npm | What it is |
| --- | --- | --- |
| [`regionfetch`](packages/sdk) | `npm i regionfetch` | TypeScript SDK — fetch, recover, verify |
| [`regionfetch-mcp`](packages/mcp) | `npx regionfetch-mcp` | MCP server exposing one `regionfetch` tool |

The service itself runs at **https://regionfetch.dev**.

---

## Quick start

```bash
npm install regionfetch
```

```ts
import { RegionFetchClient } from "regionfetch";

const client = new RegionFetchClient();

const result = await client.fetchUrl(
  { url: "https://example.com/pricing", country: "DE", mode: "browser" },
  { paymentSignature },
);

console.log(result.data.body);
console.log(result.receipt.attestation.payload.country); // "DE"
```

### Supported countries and modes

Countries: **US, DE, JP, BR, IN**. Anything else is rejected locally before a
payment is created.

| Mode | What it does |
| --- | --- |
| `http` (default) | Direct proxied GET with a country-appropriate locale, user agent, and `Accept-Language`. Follows up to five redirects, revalidating each target. |
| `browser` | Headless Chromium through the regional proxy, with a country-appropriate locale, timezone, viewport, and user agent. Waits for `domcontentloaded` and returns rendered HTML. |

### Escalation tiers

`max_tier` caps how hard the service will work to retrieve a blocked page:
`L0` and `L1` use the standard regional supplier, `L2` permits escalation to a
managed unblocker and costs more. Defaults to `L1`.

The client never assumes a price — it authorizes exactly the amount the
deployment returns in its challenge, so a dearer tier needs no client change.
`L3` is not a supported capability and is rejected before any payment is
created.

L2 is priced higher than L0/L1 — $0.05 against $0.02 at the time of writing —
and the price comes from the challenge, never from the client.

### Pricing

The default list price is **$0.02 USDC per request** on **Base**
(`eip155:8453`). Price, network, timeout, and response-size limits are
deployment-controlled — read them from the 402 challenge rather than hardcoding
them.

---

## Paying

### Use the scoped `@x402/*` packages, not `x402` or `x402-fetch`

This matters more than it looks. The deployment speaks **x402 protocol v2**:

- CAIP-2 networks (`eip155:8453`), not chain names (`base`)
- an `amount` field, not `maxAmountRequired`
- the challenge in a **`PAYMENT-REQUIRED` response header**, with an empty body
- a **`PAYMENT-SIGNATURE`** request header, not `X-PAYMENT`

The unscoped `x402` and `x402-fetch` packages on npm are **v1 only**. They parse
the challenge from the response body, hardcode `x402Versions = [1]`, reject a
CAIP-2 network at the schema, and send `X-PAYMENT`. They cannot pay this API.

Install the v2 stack:

```bash
npm install regionfetch @x402/core @x402/evm viem
```

### Wallet mode — a fresh authorization per request

```ts
import { RegionFetchClient } from "regionfetch";
import { createX402PaymentProvider } from "regionfetch/x402";

const paymentProvider = await createX402PaymentProvider({
  privateKey: process.env.WALLET_KEY,
  maxAmountPerPayment: "$0.10", // per-payment ceiling; default is $0.10
});

const client = new RegionFetchClient({ paymentProvider });
const result = await client.fetchUrl({ url: "https://example.com/", country: "JP" });
```

The SDK sends one unpaid probe, reads the challenge from the header, asks the
provider for exactly one authorization, and retries once. It will never mint a
second payment for one logical fetch — if the paid attempt is still refused, you
get an error rather than a second charge.

### Explicit mode — you already hold an authorization

```ts
await client.fetchUrl(input, { paymentSignature });
```

One authorization funds one durable request. Reusing it for a *different* body
is rejected. Resending the *identical* body with the *identical* authorization
after a dropped connection is the correct recovery — see below.

### Bring your own wallet

`paymentProvider` is a one-method interface, so you are not tied to viem or to
any particular custody model:

```ts
const paymentProvider = {
  async createPayment({ paymentRequired, resourceUrl }) {
    return myWalletService.authorize(paymentRequired, resourceUrl);
  },
};
```

---

## Verifying receipts

Every terminal outcome — success *and* paid failure — carries a signed receipt.

```ts
import { verifyReceipt } from "regionfetch";

const key = await client.getAttestationKey();

const verification = verifyReceipt(result.receipt, {
  expectedKeyId: key.keyId,
  expectedPublicKeyPem: key.publicKeyPem,
  responseBody: result.data.body,
});

verification.valid; // true only if every check that ran passed
```

Four independent checks, because a valid signature alone proves less than it
appears to:

| Check | What it rules out |
| --- | --- |
| `signatureValid` | Tampering with the signed bytes |
| `payloadMatches` | A `payload` edited after signing, leaving `payloadCanonical` intact |
| `receiptFieldsMatch` | Convenience fields at the receipt root disagreeing with what was signed |
| `bodyHashMatches` | A body swapped in transit |
| `keyMatchesExpectation` | A self-consistent receipt minted with someone else's key |

Two things the implementation is strict about:

- **Verification uses `payloadCanonical` verbatim.** Re-serializing
  `attestation.payload` can produce different bytes and either fails spuriously
  or, worse, masks a mismatch.
- **The key's real type is checked, not its label.** `attestation.algorithm` is
  attacker-controlled text; an RSA key presented as `"Ed25519"` is rejected.

Without a pinned or independently retrieved key, verification proves internal
consistency only — anyone can mint a self-consistent receipt with their own key.
Pass `expectedKeyId` / `expectedPublicKeyPem` when you need origin trust.

---

## Errors and recovery

```ts
import { RegionFetchApiError } from "regionfetch";

try {
  await client.fetchUrl(input, { paymentSignature });
} catch (error) {
  if (error instanceof RegionFetchApiError && error.isPaidFailure) {
    // Payment settled; the attempt failed terminally. Keep the receipt —
    // it is the evidence that the paid attempt happened.
    await store(error.receipt);
  }
}
```

| Status | Meaning | What the SDK does |
| --- | --- | --- |
| `400` | Invalid body, country, mode, or target | Throws. Do not retry unchanged. |
| `402` | Payment absent or unverified | Throws `RegionFetchPaymentRequiredError` with the decoded challenge |
| `409` | Same payment already processing | Retries the identical request with the same authorization |
| `429` | Rate limited | Retries with exponential backoff, honouring `Retry-After` |
| `502` / `504` | Terminal paid failure | Throws with the signed receipt attached. Never retried. |
| `503` | Service or dependency unavailable | Throws. Not retried by default. |

Default policy: two retries, exponential backoff with jitter, `Retry-After`
respected. Configure with `retry: { maxRetries, baseDelayMs, maxDelayMs }`.

### After an ambiguous failure

If the connection drops after you sent a payment, **do not create a second
payment** — but be aware that resending the identical authorization will not
recover the result either. x402 `exact` uses EIP-3009, whose nonce is spent
on-chain at settlement, so a settled payment is refused with `402` rather than
replayed. Resending is harmless (it cannot charge twice), it just will not work.

The reliable recovery is the status endpoint, so **capture `requestId` from
every response you do receive**:

```ts
const state = await client.getRequest(requestId);
```

| `state.status` | Meaning |
| --- | --- |
| `succeeded` / `failed` | Terminal. A stored failure arrives as HTTP 200, with the detail in the receipt. |
| `settling` / `executing` | Still in flight. |
| `unresolved` | Execution may have happened but was never persisted. The server will not re-run it — that could duplicate an external effect after payment. Reconcile against the settlement transaction. |

---

## Local validation is load-bearing

The deployment's payment gate runs **ahead of** body validation: an unpaid
request with `country: "ZZ"` still answers 402, not 400. So the SDK validates
input before touching the network — otherwise you would mint an authorization
for a request the server then rejects.

Checked locally: HTTPS-only, URL length ≤ 2048, known country, known mode, no
unknown fields, and obvious loopback/private targets. The server remains
authoritative for DNS resolution and the real public-target policy.

---

## MCP server

```bash
npx -y regionfetch-mcp
```

```json
{
  "mcpServers": {
    "regionfetch": {
      "command": "npx",
      "args": ["-y", "regionfetch-mcp"],
      "env": {
        "REGION_FETCH_BASE_URL": "https://regionfetch.dev",
        "REGION_FETCH_WALLET_PRIVATE_KEY": "0x...",
        "REGION_FETCH_MAX_PAYMENT": "$0.10"
      }
    }
  }
}
```

Exposes exactly one tool, `regionfetch`, taking `url`, `country`, and optional
`mode`. Results use the `{ status, ok, response }` envelope, with the upstream
JSON body preserved verbatim and `isError: true` on any non-2xx — including paid
failures, whose signed receipts survive intact.

See [packages/mcp/README.md](packages/mcp/README.md) for configuration,
payment modes, and the full environment variable list.

---

## Repository layout

```
packages/sdk/     regionfetch      — client, verification, x402 provider
packages/mcp/     regionfetch-mcp  — stdio MCP server
examples/                          — runnable integration examples
openapi/                           — client-side snapshot of the HTTP contract
test/                              — opt-in live compatibility smoke test
```

### Development

```bash
npm install
npm run build
npm test
```

Live checks against production are gated and never run in CI:

```bash
REGION_FETCH_LIVE_SMOKE=1 npm run smoke                      # free
REGION_FETCH_LIVE_SMOKE_SPEND=1 \
  REGION_FETCH_WALLET_PRIVATE_KEY=0x... npm run smoke        # spends USDC
```

---

## Security

Never pass a private key as a fetch argument or an MCP tool input. Payment
signatures are bearer credentials — the SDK redacts them from every diagnostic
path and the MCP server keeps them off both stdout and stderr.

See [SECURITY.md](SECURITY.md).

## Contract notes

[`openapi/regionfetch.openapi.yaml`](openapi/regionfetch.openapi.yaml) is the
SDK's snapshot of the HTTP contract, verified against the live API. An
authoritative document published by the service will supersede it.

[CONTRACT.md](CONTRACT.md) records the behaviours the client is built around —
including why the x402 challenge is read from a header rather than the response
body, and why input is validated before any payment is created.

## Contributing

Issues and pull requests are welcome. Please run `npm run build && npm test &&
npm run typecheck` before opening a PR, and add a test for any behaviour change
— the contract tests in `packages/sdk/test` are the guard against silently
drifting away from the deployed API.

For anything security-sensitive, follow [SECURITY.md](SECURITY.md) rather than
opening a public issue.

## Versioning

SemVer. A new country or mode is an additive minor; removing one, renaming a
field, or changing payment or receipt-signing semantics is a major. The receipt
payload `version` (currently `"1"`) is versioned independently of the package.

## License

MIT
