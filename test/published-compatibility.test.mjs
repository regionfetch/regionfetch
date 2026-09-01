/**
 * Compatibility smoke test against a live Region Fetch deployment.
 *
 * Two gates, because they carry different costs:
 *
 *   REGION_FETCH_LIVE_SMOKE=1        free checks — health, the 402 challenge,
 *                                    the attestation key, a 404 lookup
 *   REGION_FETCH_LIVE_SMOKE_SPEND=1  paid checks — a real fetch, a replay, and
 *                                    a status lookup. THIS SPENDS USDC.
 *
 * Never wire either gate into pull-request CI.
 *
 *   npm run smoke
 */
import assert from "node:assert/strict";
import { describe, it, before } from "node:test";

import {
  RegionFetchClient,
  RegionFetchPaymentRequiredError,
  decodePaymentRequiredHeader,
  verifyReceipt,
} from "regionfetch";

const BASE_URL = process.env.REGION_FETCH_BASE_URL ?? "https://regionfetch.dev";
const FREE_ENABLED = process.env.REGION_FETCH_LIVE_SMOKE === "1";
const SPEND_ENABLED = process.env.REGION_FETCH_LIVE_SMOKE_SPEND === "1";
const WALLET_KEY = process.env.REGION_FETCH_WALLET_PRIVATE_KEY;

const freeSkip = FREE_ENABLED ? false : "set REGION_FETCH_LIVE_SMOKE=1 to run";
const spendSkip = !SPEND_ENABLED
  ? "set REGION_FETCH_LIVE_SMOKE_SPEND=1 to run (spends USDC)"
  : !WALLET_KEY
    ? "set REGION_FETCH_WALLET_PRIVATE_KEY to a funded Base wallet"
    : false;

describe("live deployment — free checks", { skip: freeSkip }, () => {
  const client = new RegionFetchClient({ baseUrl: BASE_URL });

  it("reports healthy", async () => {
    assert.equal((await client.health()).status, "ok");
  });

  it("answers an unpaid fetch with a usable x402 v2 challenge", async () => {
    await assert.rejects(
      () => client.fetchUrl({ url: "https://example.com/", country: "US", mode: "http" }),
      (error) => {
        assert.ok(error instanceof RegionFetchPaymentRequiredError);
        assert.equal(error.status, 402);
        assert.ok(
          error.paymentRequiredHeader,
          "the challenge must arrive in the PAYMENT-REQUIRED header; the body is empty",
        );

        const challenge = decodePaymentRequiredHeader(error.paymentRequiredHeader);
        assert.equal(challenge.x402Version, 2, "v1 clients cannot pay this deployment");
        assert.ok(challenge.accepts.length > 0);

        const [requirement] = challenge.accepts;
        assert.equal(requirement.scheme, "exact");
        assert.match(requirement.network, /^eip155:/, "expected a CAIP-2 network");
        assert.ok(requirement.amount ?? requirement.maxAmountRequired);
        assert.ok(requirement.payTo);
        return true;
      },
    );
  });

  it("publishes an Ed25519 attestation key", async () => {
    const key = await client.getAttestationKey();
    assert.equal(key.algorithm, "Ed25519");
    assert.match(key.keyId, /^[0-9a-f]{16}$/);
    assert.match(key.publicKeyPem, /^-----BEGIN PUBLIC KEY-----/);
  });

  it("returns request_not_found for an unknown request id", async () => {
    await assert.rejects(
      () => client.getRequest("gf_00000000000000000000000000000000"),
      (error) => error.status === 404 && error.code === "request_not_found",
    );
  });
});

describe("live deployment — paid checks", { skip: spendSkip }, () => {
  let client;
  let capturedSignature;
  let result;

  before(async () => {
    const { createX402PaymentProvider } = await import("regionfetch/x402");
    const inner = await createX402PaymentProvider({
      privateKey: WALLET_KEY,
      maxAmountPerPayment: "$0.10",
    });

    // Capture the authorization so the replay check can resend the exact one.
    // Minting a second payment would test the wrong thing entirely.
    client = new RegionFetchClient({
      baseUrl: BASE_URL,
      paymentProvider: {
        async createPayment(context) {
          capturedSignature = await inner.createPayment(context);
          return capturedSignature;
        },
      },
    });
  });

  it("completes a paid fetch and returns a signed receipt", async () => {
    result = await client.fetchUrl({
      url: "https://example.com/",
      country: "US",
      mode: "http",
    });

    assert.ok(result.data.body.length > 0);
    assert.match(result.receipt.requestId, /^gf_[0-9a-f]{32}$/);
    assert.equal(result.receipt.attestation.algorithm, "Ed25519");
    assert.equal(result.receipt.status, "succeeded");
  });

  it("verifies the receipt against the deployment's published key", async () => {
    const key = await client.getAttestationKey();
    assert.equal(
      key.keyId,
      result.receipt.attestation.keyId,
      "the published key must be the one that signed the receipt",
    );

    const verification = verifyReceipt(result.receipt, {
      expectedKeyId: key.keyId,
      expectedPublicKeyPem: key.publicKeyPem,
      responseBody: result.data.body,
    });
    assert.equal(verification.valid, true, verification.errors.join("; "));
    assert.equal(verification.bodyHashMatches, true);
  });

  it("attests the country that was requested", async () => {
    assert.equal(result.receipt.attestation.payload.country, "US");
    assert.equal(result.receipt.attestation.payload.mode, "http");
  });

  it("refuses a settled payment rather than replaying it", async () => {
    // The documented behaviour (handoff section 11) is that resubmitting a
    // settled payment returns the stored result with `replayed: true`. It does
    // not, and structurally cannot: x402 exact uses EIP-3009, whose nonce is
    // consumed on-chain at settlement, and the facilitator verify runs before
    // the durable-record replay check. Verify fails on the spent nonce and the
    // request never reaches the replay path.
    //
    // This asserts what the deployment actually does, so the divergence stays
    // visible. If the server is reordered to check its record first, this test
    // fails and should be rewritten to assert the replay.
    await assert.rejects(
      () =>
        client.fetchUrl(
          { url: "https://example.com/", country: "US", mode: "http" },
          { paymentSignature: capturedSignature },
        ),
      (error) => {
        assert.equal(error.status, 402, "a spent authorization is refused, not replayed");
        return true;
      },
    );
  });

  it("returns the terminal result from the status endpoint", async () => {
    const state = await client.getRequest(result.receipt.requestId);
    assert.equal(state.status, "succeeded");
    assert.equal(state.receipt.requestId, result.receipt.requestId);
  });
});
