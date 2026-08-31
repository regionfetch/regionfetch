import { generateKeyPairSync, sign } from "node:crypto";

import { sha256Hex } from "../src/verify.js";
import type {
  RegionFetchAttestationPayload,
  RegionFetchReceipt,
} from "../src/types.js";

const keyPair = generateKeyPairSync("ed25519");
export const TEST_PUBLIC_KEY_PEM = keyPair.publicKey
  .export({ type: "spki", format: "pem" })
  .toString();
export const TEST_KEY_ID = "0123456789abcdef";
export const TEST_REQUEST_ID = "gf_0123456789abcdef0123456789abcdef";
export const TEST_BODY = "<!doctype html><title>hello</title>";

/** Build a receipt signed by the test key, matching how the server signs. */
export function makeReceipt(
  overrides: Partial<RegionFetchAttestationPayload> = {},
  receiptOverrides: Partial<RegionFetchReceipt> = {},
): RegionFetchReceipt {
  const payload: RegionFetchAttestationPayload = {
    version: "1",
    requestId: TEST_REQUEST_ID,
    paymentId: "eip155:8453:abc",
    targetUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    country: "US",
    mode: "http",
    supplier: "test-supplier",
    status: "succeeded",
    statusCode: 200,
    bytesTransferred: TEST_BODY.length,
    contentSha256: sha256Hex(TEST_BODY),
    completedAt: "2026-08-30T18:00:00.000Z",
    ...overrides,
  };

  // The server signs `JSON.stringify(payload)` and returns that exact string.
  const payloadCanonical = JSON.stringify(payload);
  const signature = sign(null, Buffer.from(payloadCanonical, "utf8"), keyPair.privateKey)
    .toString("base64url");

  return {
    requestId: payload.requestId,
    supplier: payload.supplier,
    country: payload.country,
    mode: payload.mode,
    status: payload.status,
    statusCode: payload.statusCode,
    finalUrl: payload.finalUrl,
    bytesTransferred: payload.bytesTransferred,
    contentSha256: payload.contentSha256,
    completedAt: payload.completedAt,
    attestation: {
      algorithm: "Ed25519",
      keyId: TEST_KEY_ID,
      publicKeyPem: TEST_PUBLIC_KEY_PEM,
      payload,
      payloadCanonical,
      signature,
    },
    ...receiptOverrides,
  };
}

export interface MockCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface MockResponseSpec {
  status: number;
  body?: unknown;
  /** Raw text body, used to simulate non-JSON responses. */
  text?: string;
  headers?: Record<string, string>;
}

export interface MockFetch {
  fetch: typeof globalThis.fetch;
  calls: MockCall[];
}

/** A fetch stub that replays a fixed script of responses. */
export function mockFetch(script: MockResponseSpec[]): MockFetch {
  const calls: MockCall[] = [];
  let index = 0;

  const impl = (async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as string, init);
    calls.push({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: init?.body === undefined ? undefined : String(init.body),
    });

    const spec = script[Math.min(index, script.length - 1)];
    index += 1;
    if (!spec) throw new Error("mockFetch script exhausted");

    const text = spec.text ?? (spec.body === undefined ? "" : JSON.stringify(spec.body));
    return new Response(text, {
      status: spec.status,
      headers: { "content-type": "application/json", ...spec.headers },
    });
  }) as unknown as typeof globalThis.fetch;

  return { fetch: impl, calls };
}

/** Encode an x402 challenge the way the deployment does: base64 JSON in a header. */
export function paymentRequiredHeader(challenge: unknown): string {
  return Buffer.from(JSON.stringify(challenge), "utf8").toString("base64");
}

export const SAMPLE_CHALLENGE = {
  x402Version: 2,
  error: "Payment required",
  resource: {
    url: "https://regionfetch.dev/api/fetch",
    description: "One geo-targeted web fetch with a signed receipt",
    mimeType: "application/json",
  },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:8453",
      amount: "20000",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x000000000000000000000000000000000000dEaD",
      maxTimeoutSeconds: 300,
      extra: { name: "USD Coin", version: "2" },
    },
  ],
};
