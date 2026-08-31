import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isSensitiveHeader, redactHeaders, redactText } from "../src/redact.js";

describe("redactHeaders", () => {
  it("redacts payment headers regardless of case", () => {
    const redacted = redactHeaders({
      "PAYMENT-SIGNATURE": "eyJhbGciOi-a-real-authorization",
      "X-Payment": "legacy-authorization",
      "content-type": "application/json",
    });
    assert.equal(redacted["PAYMENT-SIGNATURE"], "[redacted]");
    assert.equal(redacted["X-Payment"], "[redacted]");
    assert.equal(redacted["content-type"], "application/json");
  });

  it("redacts credentials carried in a Headers object", () => {
    const headers = new Headers({
      authorization: "Bearer secret",
      cookie: "session=abc",
      "payment-response": "settled",
      accept: "application/json",
    });
    const redacted = redactHeaders(headers);
    assert.equal(redacted["authorization"], "[redacted]");
    assert.equal(redacted["cookie"], "[redacted]");
    assert.equal(redacted["payment-response"], "[redacted]");
    assert.equal(redacted["accept"], "application/json");
  });

  it("classifies header names case-insensitively", () => {
    assert.ok(isSensitiveHeader("Payment-Signature"));
    assert.ok(!isSensitiveHeader("accept"));
  });
});

describe("redactText", () => {
  it("removes anything shaped like a private key", () => {
    const key = `0x${"a".repeat(64)}`;
    const output = redactText(`failed with key ${key}`);
    assert.ok(!output.includes(key));
    assert.ok(output.includes("[redacted]"));
  });

  it("removes labelled secrets", () => {
    const output = redactText('{"payment-signature":"eyJhbGciOiJIUzI1NiJ9abcdefghijk"}');
    assert.ok(!output.includes("eyJhbGciOiJIUzI1NiJ9abcdefghijk"));
  });
});
