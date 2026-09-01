# Security

## Reporting a vulnerability

Report privately through GitHub's **Security → Report a vulnerability** on this
repository. Please do not open a public issue for anything exploitable.

Include what you did, what happened, and what you expected. If a payment
authorization or wallet key was involved, describe it — never paste the value.

---

## The rules that matter most

### Never pass a private key as an argument

Not to `fetchUrl`, not as an MCP tool input, not in a request body. Key material
belongs in your MCP host's `env` block or your wallet service, where a model
cannot see or choose it. `createX402PaymentProvider` accepts `privateKey` for
server-side convenience only — validated by shape, never echoed into an error.

### Payment signatures are bearer credentials

An x402 authorization is spendable by whoever holds it. Treat it exactly like an
unencrypted API key in transit:

- TLS always. The SDK refuses a non-HTTPS base URL unless
  `allowInsecureHttpForDevelopment` is set.
- Never logged. `redactHeaders` strips `PAYMENT-SIGNATURE`, `X-Payment`,
  `PAYMENT-RESPONSE`, `Authorization`, and cookies from every diagnostic; a test
  asserts a real signature never appears in emitted events.
- Never persisted, and never forwarded through an intermediary.

### One payment funds one request

Reusing an authorization for a *different* body is a protocol violation. The SDK
enforces the safe direction of this:

- Retries on `409` and `429` resend the **identical** body with the **same**
  authorization.
- A single logical `fetchUrl` call will never create a second payment, even if
  the paid attempt is refused again.

After an ambiguous connection failure, call `getRequest(requestId)`. Resending
the identical authorization is safe but will not recover the result: the EIP-3009
nonce is spent at settlement, so the deployment refuses it with `402`. Creating a
*fresh* payment is the thing that risks paying twice — never do that.

### Verify before you trust

A receipt carries the key that signed it, so a valid signature alone proves only
internal consistency — anyone can mint a self-consistent receipt with their own
key. For origin trust, pin `expectedKeyId` / `expectedPublicKeyPem`, or retrieve
the key from `/api/attestation-key` yourself.

Two implementation details that are load-bearing:

- Verification uses `payloadCanonical` verbatim. Re-serializing
  `attestation.payload` can produce different bytes.
- The public key's real type is checked, not the self-declared `algorithm`
  string. An RSA key labelled `"Ed25519"` is rejected.

### Preserve terminal failure receipts

A `502` or `504` means payment settled and the attempt failed. The attached
receipt is the evidence that it happened and is required for reconciliation.
`RegionFetchApiError.receipt` carries it; the MCP server keeps it in the
response envelope. Do not discard it because the call "failed".

---

## Threats this client is built against

| Threat | Mitigation |
| --- | --- |
| SSRF via user-supplied URLs | HTTPS-only, loopback/private-range rejection client-side; the server enforces the real policy after DNS resolution |
| Payment replay across different inputs | One authorization per logical fetch; retries never change the body |
| Duplicate payment after a network failure | Retries reuse the authorization; `getRequest` recovers without spending |
| Payment payloads leaking into model context | MCP output carries no authorization; stdio tests assert it |
| Trusting a self-supplied receipt key | Key pinning and independent retrieval |
| Re-serializing attestation payloads | Verification is defined over `payloadCanonical` only |
| Algorithm substitution in a receipt | `asymmetricKeyType` is checked against `ed25519` |
| Malformed or non-JSON upstream responses | Parsed defensively; an HTML response produces a clear protocol error naming `baseUrl` |
| Unbounded waits | Every request carries a timeout and honours an `AbortSignal` |
| Supply-chain compromise | Pinned dev dependencies, npm provenance on publish |

## Scope

This repository covers the client packages. Vulnerabilities in the hosted
service — SSRF enforcement, supplier handling, settlement, receipt signing —
belong to the deployment at `regionfetch.dev`. Report those the same way and
they will be routed.
