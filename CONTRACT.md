# Contract notes

What the deployed API actually does, where it differs from its own
documentation, and what the client works around. Verified against
`https://regionfetch.dev` on **2026-08-30**.

## Verified divergences

These were confirmed by probing production, not read from a document.

### 1. The 402 body is empty — FIXED UPSTREAM

*Resolved 2026-09-01: the body now carries a proper `{"error":{"code":"payment_required"}}`
envelope, and the challenge additionally includes Bazaar discovery metadata,
`serviceName`, and `tags`. The client still reads requirements from the header
only, which is correct either way. Original observation follows.*

### 1a. Original: the 402 body was empty

The handoff describes `402` as returning
`{"error":{"code":"payment_required", ...}}`. It returns `{}`.

The challenge is carried in the **`PAYMENT-REQUIRED` header** as base64 JSON.

```
HTTP/2 402
payment-required: eyJ4NDAyVmVyc2lvbiI6MiwiZXJyb3IiOiJQYXltZW50IHJlcXVpcmVk...
content-length: 2

{}
```

*Client impact:* requirements are read from the header only. A `402` with no
usable header produces an error rather than a guessed payment — inventing
requirements from a hardcoded default price risks paying the wrong amount on the
wrong chain.

### 2. The payment gate runs before body validation

```bash
curl -X POST https://regionfetch.dev/api/fetch \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/","country":"ZZ"}'
# → HTTP 402, not 400
```

*Client impact:* input is validated locally before any network call. Without
that, a caller would mint an authorization for a request the server rejects.

### 3. The deployment speaks x402 v2, and the popular npm client speaks v1

Production emits:

```json
{
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "amount": "20000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxTimeoutSeconds": 300
  }]
}
```

`x402@1.2.0` and `x402-fetch@1.2.0` hardcode `x402Versions = [1]`, require
`maxAmountRequired`, restrict `network` to an enum of chain names that excludes
CAIP-2 identifiers, read the challenge from the response **body**, and send
`X-PAYMENT`. They cannot pay this deployment.

The v2 stack is the scoped `@x402/*` packages at `2.24.x`. `@x402/fetch`'s
`getPaymentRequiredResponse()` reads the `PAYMENT-REQUIRED` header first and
falls back to a body only when `x402Version === 1`, so the header-plus-empty-body
shape works with it unchanged.

*Client impact:* `regionfetch/x402` builds on `@x402/core` and `@x402/evm`.
Documented prominently, because reaching for the obvious package silently fails.

### 4. Discovery endpoints return the marketing SPA with HTTP 200

`/.well-known/x402`, `/openapi.yaml`, and any other unmatched path return
`index.html` with **HTTP 200** and `content-type: text/html`. A naive fetch sees
a success and gets HTML.

*Client impact:* a non-JSON response raises `RegionFetchProtocolError` naming
`baseUrl`, rather than failing somewhere further down. There is no published
OpenAPI URL, so `openapi/regionfetch.openapi.yaml` here is a client-side
snapshot.

### 5. The challenge advertises an `http://` resource URL

```json
"resource": { "url": "http://regionfetch.dev/api/fetch" }
```

Protocol mis-detection behind the Google Frontend proxy — the request arrived
over HTTPS. Harmless for the current client, which builds its own resource URL,
but an x402 client that binds a payment to the advertised resource could produce
an authorization the server then rejects.

*Client impact:* `regionfetch` builds its own resource URL and is unaffected.
If you integrate with a different x402 client that binds a payment to the
advertised `resource.url`, prefer the origin you actually dialled.

### 6. A rejected payment is reported as a bare 402

When a payment is supplied but not accepted, the deployment answers `402` with
an empty body **and no `PAYMENT-REQUIRED` header at all** — so at the protocol
level it is indistinguishable from a request that carried no payment, and it
carries no reason for the rejection.

*Client impact:* the client tracks whether it sent a payment and reports the two
cases differently. A rejection names the payer wallet extracted from the
authorization, so the caller knows which balance to check, rather than being
told to configure a payment provider they already configured.

### 7. A settled payment is refused, not replayed

Documented behaviour is that resubmitting a settled payment returns the stored
result with `replayed: true`. Verified against production: it returns `402`.

The cause looks structural rather than incidental. x402 `exact` uses EIP-3009
`transferWithAuthorization`, whose nonce is consumed on-chain at settlement, and
the facilitator verify runs *before* the durable-record replay check. Verify
fails on the spent nonce, so the replay path is unreachable for any payment that
actually settled.

*Client impact:* recovery after an ambiguous failure must use
`GET /api/fetch/{requestId}`. Capture `requestId` from every response you
receive. Resending the authorization is harmless — it cannot charge twice — but
it will not return the result.

### 8. Escalation tiers

Verified deployed on 2026-09-01:

| Request | Challenge amount |
| --- | --- |
| no `max_tier` | `20000` ($0.02) |
| `L0` / `L1` | `20000` ($0.02) |
| `L2` | `50000` ($0.05) |
| `L3` | rejected — `503 tier_unavailable`, before payment |

The published Bazaar schema declares `max_tier` with enum `["L0","L1","L2"]`,
`supplier` as `["decodo","iproyal"]`, and adds `maxTier`, `resolvedTier` and
`quotedAmount` to the receipt.

*Client impact:* none required. The client authorizes exactly the amount in the
challenge, so the dearer L2 requirement is honoured without a client change.
`L3` is rejected locally before any request, which is a better outcome than the
server's `503`.

Note the tier price is set by the **challenge**, not by the request body: a
client that hardcoded $0.02 would under-authorize an L2 request and be refused.

## Confirmed as documented

- `GET /api/healthz` → `200 {"status":"ok"}`
- `GET /api/attestation-key` → `200` with an Ed25519 key and a 16-hex `keyId`
  (keys rotate; retrieve rather than pinning a literal)
- `GET /api/fetch/{unknown}` → `404 {"error":{"code":"request_not_found", ...}}`
- Canonical `PAYMENT-SIGNATURE` request header
- CORS is `*` and allows `payment-signature`, so browser use is viable

## Reading attested values

Until the receipt top-level fields are normalized across initial and
replay/status responses, read attested values from
`receipt.attestation.payload`, never from the receipt's top-level duplicates.
The SDK's `verifyReceipt` cross-checks the two and fails when they disagree, so
a mismatch surfaces as a verification error rather than a silently wrong value.
