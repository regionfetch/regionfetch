import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { describeConfig, loadConfig } from "../src/config.js";

const KEY = `0x${"a".repeat(64)}`;

describe("loadConfig", () => {
  it("defaults to the production origin with no payment configured", () => {
    const config = loadConfig({});
    assert.equal(config.baseUrl, "https://regionfetch.dev");
    assert.equal(config.paymentMode, "none");
    assert.equal(config.maxAmountPerPayment, "$0.10");
    assert.equal(config.timeoutMs, 120_000);
  });

  it("normalizes a base URL that includes /api", () => {
    const config = loadConfig({ REGION_FETCH_BASE_URL: "https://staging.test/api/" });
    assert.equal(config.baseUrl, "https://staging.test");
  });

  it("reads legacy GEOFETCH_ names and records them as deprecated", () => {
    const config = loadConfig({
      GEOFETCH_BASE_URL: "https://legacy.test",
      GEOFETCH_PAYMENT_SIGNATURE: "legacy-signature",
    });
    assert.equal(config.baseUrl, "https://legacy.test");
    assert.equal(config.paymentSignature, "legacy-signature");
    assert.deepEqual(config.legacyVariablesUsed, ["GEOFETCH_BASE_URL", "GEOFETCH_PAYMENT_SIGNATURE"]);
  });

  it("prefers canonical names over legacy ones", () => {
    const config = loadConfig({
      REGION_FETCH_BASE_URL: "https://new.test",
      GEOFETCH_BASE_URL: "https://legacy.test",
      REGION_FETCH_PAYMENT_SIGNATURE: "new-signature",
      PAYMENT_SIGNATURE: "oldest-signature",
    });
    assert.equal(config.baseUrl, "https://new.test");
    assert.equal(config.paymentSignature, "new-signature");
    assert.deepEqual(config.legacyVariablesUsed, []);
  });

  it("chooses wallet mode over a static signature when both are present", () => {
    // A static signature funds one request; a wallet keeps working. Preferring
    // the wallet is the only choice that leaves the server usable.
    const config = loadConfig({
      REGION_FETCH_WALLET_PRIVATE_KEY: KEY,
      REGION_FETCH_PAYMENT_SIGNATURE: "one-shot",
    });
    assert.equal(config.paymentMode, "wallet");
  });

  it("treats blank values as unset", () => {
    const config = loadConfig({ REGION_FETCH_PAYMENT_SIGNATURE: "   " });
    assert.equal(config.paymentMode, "none");
  });

  it("parses the spend cap, including the off switch", () => {
    assert.equal(loadConfig({ REGION_FETCH_MAX_PAYMENT: "$1.50" }).maxAmountPerPayment, "$1.50");
    assert.equal(loadConfig({ REGION_FETCH_MAX_PAYMENT: "off" }).maxAmountPerPayment, false);
  });

  it("falls back to the default timeout for nonsense values", () => {
    assert.equal(loadConfig({ REGION_FETCH_TIMEOUT_MS: "abc" }).timeoutMs, 120_000);
    assert.equal(loadConfig({ REGION_FETCH_TIMEOUT_MS: "-5" }).timeoutMs, 120_000);
    assert.equal(loadConfig({ REGION_FETCH_TIMEOUT_MS: "30000" }).timeoutMs, 30_000);
  });

  it("rejects an http base URL unless development is opted into", () => {
    assert.throws(() => loadConfig({ REGION_FETCH_BASE_URL: "http://localhost:3000" }));
    assert.equal(
      loadConfig({
        REGION_FETCH_BASE_URL: "http://localhost:3000",
        REGION_FETCH_ALLOW_INSECURE_HTTP: "1",
      }).baseUrl,
      "http://localhost:3000",
    );
  });
});

describe("describeConfig", () => {
  it("never prints the wallet key or the payment signature", () => {
    const summary = describeConfig(
      loadConfig({ REGION_FETCH_WALLET_PRIVATE_KEY: KEY }),
    ).join("\n");
    assert.ok(!summary.includes(KEY));
    assert.ok(summary.includes("wallet"));

    const staticSummary = describeConfig(
      loadConfig({ REGION_FETCH_PAYMENT_SIGNATURE: "a-real-authorization" }),
    ).join("\n");
    assert.ok(!staticSummary.includes("a-real-authorization"));
  });

  it("warns that a static signature funds only one request", () => {
    const summary = describeConfig(loadConfig({ PAYMENT_SIGNATURE: "x" })).join("\n");
    assert.ok(summary.includes("one request"));
    assert.ok(summary.includes("deprecated"));
  });
});
