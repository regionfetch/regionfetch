import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RegionFetchClient } from "../src/client.js";
import {
  RegionFetchApiError,
  RegionFetchPaymentProviderError,
  RegionFetchPaymentRequiredError,
  RegionFetchProtocolError,
  RegionFetchValidationError,
} from "../src/errors.js";
import type { RegionFetchPaymentProvider } from "../src/payment.js";
import {
  SAMPLE_CHALLENGE,
  TEST_BODY,
  TEST_REQUEST_ID,
  makeReceipt,
  mockFetch,
  paymentRequiredHeader,
  type MockResponseSpec,
} from "./helpers.js";

const INPUT = { url: "https://example.com/", country: "US" } as const;

const SUCCESS_BODY = {
  data: { url: "https://example.com/", contentType: "text/html; charset=UTF-8", body: TEST_BODY },
  receipt: makeReceipt(),
};

/** A 402 exactly as the deployment sends it: challenge in a header, empty body. */
const CHALLENGE_402: MockResponseSpec = {
  status: 402,
  body: {},
  headers: { "payment-required": paymentRequiredHeader(SAMPLE_CHALLENGE) },
};

function clientWith(script: MockResponseSpec[], provider?: RegionFetchPaymentProvider) {
  const mock = mockFetch(script);
  const client = new RegionFetchClient({
    fetch: mock.fetch,
    retry: { baseDelayMs: 1, maxDelayMs: 2 },
    ...(provider === undefined ? {} : { paymentProvider: provider }),
  });
  return { client, mock };
}

function countingProvider(signature = "signed-authorization"): RegionFetchPaymentProvider & {
  calls: number;
} {
  const provider = {
    calls: 0,
    async createPayment() {
      provider.calls += 1;
      return signature;
    },
  };
  return provider;
}

describe("fetchUrl with an explicit payment signature", () => {
  it("sends the canonical PAYMENT-SIGNATURE header and returns the result", async () => {
    const { client, mock } = clientWith([{ status: 200, body: SUCCESS_BODY }]);
    const result = await client.fetchUrl(INPUT, { paymentSignature: "abc123" });

    assert.equal(result.data.body, TEST_BODY);
    assert.equal(result.receipt.requestId, TEST_REQUEST_ID);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]?.headers["payment-signature"], "abc123");
    assert.equal(mock.calls[0]?.url, "https://regionfetch.dev/api/fetch");
    assert.equal(mock.calls[0]?.headers["x-payment"], undefined);
  });

  it("rejects bad input before any request is made", async () => {
    const { client, mock } = clientWith([{ status: 200, body: SUCCESS_BODY }]);
    await assert.rejects(
      () => client.fetchUrl({ ...INPUT, country: "ZZ" as never }, { paymentSignature: "abc" }),
      RegionFetchValidationError,
    );
    // The deployment's payment gate runs ahead of body validation, so a request
    // here would have burned an authorization on a request it would then reject.
    assert.equal(mock.calls.length, 0);
  });
});

describe("fetchUrl with a payment provider", () => {
  it("probes unpaid, then pays exactly once using the header challenge", async () => {
    const provider = countingProvider();
    const { client, mock } = clientWith([CHALLENGE_402, { status: 200, body: SUCCESS_BODY }], provider);

    const result = await client.fetchUrl(INPUT);

    assert.equal(result.data.body, TEST_BODY);
    assert.equal(provider.calls, 1);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0]?.headers["payment-signature"], undefined);
    assert.equal(mock.calls[1]?.headers["payment-signature"], "signed-authorization");
    assert.equal(mock.calls[0]?.body, mock.calls[1]?.body, "the paid retry must resend the same body");
  });

  it("passes the decoded challenge to the provider", async () => {
    let seen: unknown;
    const provider: RegionFetchPaymentProvider = {
      async createPayment(context) {
        seen = context.paymentRequired;
        return "sig";
      },
    };
    const { client } = clientWith([CHALLENGE_402, { status: 200, body: SUCCESS_BODY }], provider);
    await client.fetchUrl(INPUT);
    assert.deepEqual(seen, SAMPLE_CHALLENGE);
  });

  it("refuses to invent requirements when the 402 carries no challenge", async () => {
    const provider = countingProvider();
    const { client } = clientWith([{ status: 402, body: {} }], provider);

    await assert.rejects(
      () => client.fetchUrl(INPUT),
      (error: unknown) =>
        error instanceof RegionFetchPaymentRequiredError &&
        error.paymentRequired === undefined &&
        error.message.includes("no payment was created"),
    );
    assert.equal(provider.calls, 0);
  });

  it("does not create a second payment when the paid request is still refused", async () => {
    const provider = countingProvider();
    const { client } = clientWith([CHALLENGE_402, CHALLENGE_402], provider);

    await assert.rejects(() => client.fetchUrl(INPUT), RegionFetchPaymentRequiredError);
    assert.equal(provider.calls, 1, "one logical fetch must never mint two payments");
  });

  it("surfaces a provider failure without retrying", async () => {
    const provider: RegionFetchPaymentProvider = {
      async createPayment() {
        throw new Error("wallet offline");
      },
    };
    const { client, mock } = clientWith([CHALLENGE_402], provider);

    await assert.rejects(() => client.fetchUrl(INPUT), RegionFetchPaymentProviderError);
    assert.equal(mock.calls.length, 1);
  });

  it("rejects an empty authorization from a provider", async () => {
    const { client } = clientWith([CHALLENGE_402], countingProvider(""));
    await assert.rejects(() => client.fetchUrl(INPUT), RegionFetchPaymentProviderError);
  });
});

describe("fetchUrl without any payment configured", () => {
  it("throws a payment-required error carrying the decoded challenge", async () => {
    const { client } = clientWith([CHALLENGE_402]);
    await assert.rejects(
      () => client.fetchUrl(INPUT),
      (error: unknown) => {
        assert.ok(error instanceof RegionFetchPaymentRequiredError);
        assert.equal(error.status, 402);
        assert.equal(error.paymentRequired?.x402Version, 2);
        assert.equal(error.paymentRequired?.accepts[0]?.amount, "20000");
        assert.ok(error.paymentRequiredHeader);
        return true;
      },
    );
  });
});

describe("retry semantics", () => {
  it("retries 409 payment_in_progress with the same authorization", async () => {
    const { client, mock } = clientWith([
      { status: 409, body: { error: { code: "payment_in_progress", message: "processing" } } },
      { status: 200, body: SUCCESS_BODY },
    ]);

    const result = await client.fetchUrl(INPUT, { paymentSignature: "abc123" });

    assert.equal(result.data.body, TEST_BODY);
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0]?.headers["payment-signature"], "abc123");
    assert.equal(mock.calls[1]?.headers["payment-signature"], "abc123");
  });

  it("retries 429 and honours Retry-After", async () => {
    const { client, mock } = clientWith([
      {
        status: 429,
        body: { error: { code: "rate_limited", message: "slow down" } },
        headers: { "retry-after": "0" },
      },
      { status: 200, body: SUCCESS_BODY },
    ]);
    await client.fetchUrl(INPUT, { paymentSignature: "abc123" });
    assert.equal(mock.calls.length, 2);
  });

  it("gives up after the retry budget and reports the last error", async () => {
    const { client, mock } = clientWith([
      { status: 409, body: { error: { code: "payment_in_progress", message: "busy" } } },
    ]);
    await assert.rejects(
      () => client.fetchUrl(INPUT, { paymentSignature: "abc" }),
      (error: unknown) =>
        error instanceof RegionFetchApiError && error.code === "payment_in_progress",
    );
    assert.equal(mock.calls.length, 3, "one attempt plus two retries");
  });

  it("never retries a terminal paid failure", async () => {
    const { client, mock } = clientWith([
      {
        status: 502,
        body: {
          error: { code: "http_status_403", message: "The geo-targeted supplier fetch failed." },
          receipt: makeReceipt({ status: "failed", statusCode: 403, contentSha256: null }),
        },
      },
    ]);
    await assert.rejects(() => client.fetchUrl(INPUT, { paymentSignature: "abc" }), RegionFetchApiError);
    assert.equal(mock.calls.length, 1);
  });

  it("does not retry a pre-execution 503 by default", async () => {
    const { client, mock } = clientWith([
      { status: 503, body: { error: { code: "fetch_unavailable", message: "down" } } },
    ]);
    await assert.rejects(() => client.fetchUrl(INPUT, { paymentSignature: "abc" }), RegionFetchApiError);
    assert.equal(mock.calls.length, 1);
  });
});

describe("terminal failures", () => {
  it("attaches the signed receipt to the thrown error", async () => {
    const receipt = makeReceipt({ status: "failed", statusCode: 403, contentSha256: null });
    const { client } = clientWith([
      {
        status: 502,
        body: { error: { code: "http_status_403", message: "supplier failed" }, receipt },
      },
    ]);

    await assert.rejects(
      () => client.fetchUrl(INPUT, { paymentSignature: "abc" }),
      (error: unknown) => {
        assert.ok(error instanceof RegionFetchApiError);
        assert.equal(error.status, 502);
        assert.equal(error.code, "http_status_403");
        assert.equal(error.isPaidFailure, true);
        assert.equal(error.receipt?.attestation.payload.status, "failed");
        assert.equal(error.requestId, TEST_REQUEST_ID);
        return true;
      },
    );
  });

  it("carries the receipt on a 504 timeout too", async () => {
    const { client } = clientWith([
      {
        status: 504,
        body: {
          error: { code: "timeout", message: "timed out" },
          receipt: makeReceipt({ status: "failed", statusCode: null, contentSha256: null }),
        },
      },
    ]);
    await assert.rejects(
      () => client.fetchUrl(INPUT, { paymentSignature: "abc" }),
      (error: unknown) => error instanceof RegionFetchApiError && error.isPaidFailure,
    );
  });

  it("surfaces the replayed flag", async () => {
    const { client } = clientWith([{ status: 200, body: { ...SUCCESS_BODY, replayed: true } }]);
    const result = await client.fetchUrl(INPUT, { paymentSignature: "abc" });
    assert.equal(result.replayed, true);
  });
});

describe("malformed responses", () => {
  it("explains an HTML response instead of failing obscurely", async () => {
    // Pointing baseUrl at the marketing site returns the SPA shell with HTTP 200.
    const { client } = clientWith([
      { status: 200, text: "<!doctype html><title>Region Fetch</title>", headers: { "content-type": "text/html" } },
    ]);
    await assert.rejects(
      () => client.fetchUrl(INPUT, { paymentSignature: "abc" }),
      (error: unknown) =>
        error instanceof RegionFetchProtocolError && error.message.includes("baseUrl"),
    );
  });

  it("rejects a 200 that is missing data or receipt", async () => {
    const { client } = clientWith([{ status: 200, body: { data: SUCCESS_BODY.data } }]);
    await assert.rejects(
      () => client.fetchUrl(INPUT, { paymentSignature: "abc" }),
      RegionFetchProtocolError,
    );
  });
});

describe("getRequest", () => {
  it("returns a stored terminal success", async () => {
    const { client } = clientWith([
      { status: 200, body: { status: "succeeded", data: SUCCESS_BODY.data, receipt: SUCCESS_BODY.receipt } },
    ]);
    const state = await client.getRequest(TEST_REQUEST_ID);
    assert.equal(state.status, "succeeded");
  });

  it("returns a stored terminal failure as HTTP 200 with status failed", async () => {
    const { client } = clientWith([
      { status: 200, body: { status: "failed", receipt: makeReceipt({ status: "failed" }) } },
    ]);
    const state = await client.getRequest(TEST_REQUEST_ID);
    assert.equal(state.status, "failed");
    assert.ok("receipt" in state);
  });

  it("returns pending states from a 202", async () => {
    const { client } = clientWith([
      { status: 202, body: { requestId: TEST_REQUEST_ID, status: "executing", message: "running" } },
    ]);
    const state = await client.getRequest(TEST_REQUEST_ID);
    assert.equal(state.status, "executing");
  });

  it("returns unresolved rather than throwing, so it can be reconciled", async () => {
    const { client } = clientWith([
      {
        status: 503,
        body: { requestId: TEST_REQUEST_ID, status: "unresolved", message: "not persisted" },
      },
    ]);
    const state = await client.getRequest(TEST_REQUEST_ID);
    assert.equal(state.status, "unresolved");
  });

  it("throws on request_not_found", async () => {
    const { client } = clientWith([
      { status: 404, body: { error: { code: "request_not_found", message: "not found" } } },
    ]);
    await assert.rejects(
      () => client.getRequest(TEST_REQUEST_ID),
      (error: unknown) => error instanceof RegionFetchApiError && error.code === "request_not_found",
    );
  });

  it("validates the request id shape locally", async () => {
    const { client, mock } = clientWith([{ status: 200, body: {} }]);
    await assert.rejects(() => client.getRequest("nope"), RegionFetchValidationError);
    assert.equal(mock.calls.length, 0);
  });
});

describe("health and attestation key", () => {
  it("reads the health status", async () => {
    const { client } = clientWith([{ status: 200, body: { status: "ok" } }]);
    assert.deepEqual(await client.health(), { status: "ok" });
  });

  it("reads the attestation key", async () => {
    const key = { algorithm: "Ed25519", keyId: "0123456789abcdef", publicKeyPem: "-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n" };
    const { client } = clientWith([{ status: 200, body: key }]);
    assert.deepEqual(await client.getAttestationKey(), key);
  });

  it("throws when attestation signing is unavailable", async () => {
    const { client } = clientWith([
      { status: 503, body: { error: { code: "attestation_unavailable", message: "unavailable" } } },
    ]);
    await assert.rejects(
      () => client.getAttestationKey(),
      (error: unknown) =>
        error instanceof RegionFetchApiError && error.code === "attestation_unavailable",
    );
  });
});

describe("diagnostics", () => {
  it("never emits a payment signature", async () => {
    const events: unknown[] = [];
    const mock = mockFetch([{ status: 200, body: SUCCESS_BODY }]);
    const client = new RegionFetchClient({
      fetch: mock.fetch,
      onDiagnostic: (event) => events.push(event),
    });

    await client.fetchUrl(INPUT, { paymentSignature: "super-secret-authorization" });

    const serialized = JSON.stringify(events);
    assert.ok(serialized.length > 0);
    assert.ok(!serialized.includes("super-secret-authorization"));
    assert.ok(serialized.includes("[redacted]"));
  });

  it("survives a throwing diagnostic sink", async () => {
    const mock = mockFetch([{ status: 200, body: SUCCESS_BODY }]);
    const client = new RegionFetchClient({
      fetch: mock.fetch,
      onDiagnostic: () => {
        throw new Error("sink exploded");
      },
    });
    const result = await client.fetchUrl(INPUT, { paymentSignature: "abc" });
    assert.equal(result.data.body, TEST_BODY);
  });
});

describe("rejected payment", () => {
  it("distinguishes a rejected payment from an absent one", async () => {
    // The deployment answers a rejected payment with a bare 402 — empty body,
    // no challenge header — so it looks identical to "no payment supplied".
    // Only the client knows it sent one.
    const { client } = clientWith([{ status: 402, body: {} }]);
    await assert.rejects(
      () => client.fetchUrl(INPUT, { paymentSignature: "an-authorization" }),
      (error: unknown) => {
        assert.ok(error instanceof RegionFetchPaymentRequiredError);
        assert.match(error.message, /rejected the payment/);
        assert.doesNotMatch(error.message, /configure a paymentProvider/);
        return true;
      },
    );
  });

  it("names the payer wallet so the caller knows what to fund", async () => {
    const signature = Buffer.from(
      JSON.stringify({ payload: { authorization: { from: "0xPayerWallet" } } }),
      "utf8",
    ).toString("base64");
    const { client } = clientWith([{ status: 402, body: {} }]);
    await assert.rejects(
      () => client.fetchUrl(INPUT, { paymentSignature: signature }),
      (error: unknown) =>
        error instanceof RegionFetchPaymentRequiredError &&
        error.message.includes("0xPayerWallet"),
    );
  });

  it("still asks for a provider when no payment was supplied", async () => {
    const { client } = clientWith([CHALLENGE_402]);
    await assert.rejects(
      () => client.fetchUrl(INPUT),
      (error: unknown) =>
        error instanceof RegionFetchPaymentRequiredError &&
        /configure a paymentProvider/.test(error.message),
    );
  });
});
