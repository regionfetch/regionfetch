import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import { sha256Hex, verifyReceipt } from "../src/verify.js";
import {
  TEST_BODY,
  TEST_KEY_ID,
  TEST_PUBLIC_KEY_PEM,
  makeReceipt,
} from "./helpers.js";

describe("verifyReceipt", () => {
  it("accepts a well-formed receipt", () => {
    const result = verifyReceipt(makeReceipt());
    assert.equal(result.valid, true, result.errors.join("; "));
    assert.equal(result.signatureValid, true);
    assert.equal(result.payloadMatches, true);
    assert.equal(result.receiptFieldsMatch, true);
    assert.deepEqual(result.errors, []);
  });

  it("verifies the response body against the attested hash", () => {
    const ok = verifyReceipt(makeReceipt(), { responseBody: TEST_BODY });
    assert.equal(ok.bodyHashMatches, true);
    assert.equal(ok.valid, true);

    const tampered = verifyReceipt(makeReceipt(), { responseBody: `${TEST_BODY}<!-- injected -->` });
    assert.equal(tampered.bodyHashMatches, false);
    assert.equal(tampered.valid, false);
  });

  it("rejects a receipt whose signed bytes were altered", () => {
    const receipt = makeReceipt();
    receipt.attestation.payloadCanonical = receipt.attestation.payloadCanonical.replace(
      '"US"',
      '"DE"',
    );
    const result = verifyReceipt(receipt);
    assert.equal(result.signatureValid, false);
    assert.equal(result.valid, false);
  });

  it("catches a payload edited without re-signing", () => {
    // The classic forgery: change the structured payload the caller reads while
    // leaving the signed bytes intact.
    const receipt = makeReceipt();
    receipt.attestation.payload = { ...receipt.attestation.payload, country: "DE" };
    const result = verifyReceipt(receipt);
    assert.equal(result.signatureValid, true, "signature still covers the original bytes");
    assert.equal(result.payloadMatches, false);
    assert.equal(result.valid, false);
  });

  it("catches receipt-level fields that disagree with the signed payload", () => {
    const receipt = makeReceipt();
    receipt.statusCode = 200;
    receipt.status = "succeeded";
    receipt.country = "JP";
    const result = verifyReceipt(receipt);
    assert.equal(result.receiptFieldsMatch, false);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("country")));
  });

  it("rejects a signature made by a different key", () => {
    const attacker = generateKeyPairSync("ed25519");
    const receipt = makeReceipt();
    receipt.attestation.signature = sign(
      null,
      Buffer.from(receipt.attestation.payloadCanonical, "utf8"),
      attacker.privateKey,
    ).toString("base64url");

    const result = verifyReceipt(receipt);
    assert.equal(result.signatureValid, false);
    assert.equal(result.valid, false);
  });

  it("rejects a non-Ed25519 key presented under an Ed25519 label", () => {
    // Guards against algorithm substitution: `algorithm` is attacker-controlled
    // text, so the real key type has to be checked.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const receipt = makeReceipt();
    receipt.attestation.publicKeyPem = rsa.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();

    const result = verifyReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("not ed25519")));
  });

  it("rejects a malformed signature encoding", () => {
    const receipt = makeReceipt();
    receipt.attestation.signature = "not*base64url";
    assert.equal(verifyReceipt(receipt).valid, false);

    const short = makeReceipt();
    short.attestation.signature = Buffer.alloc(32).toString("base64url");
    assert.equal(verifyReceipt(short).valid, false);
  });

  it("rejects a payloadCanonical that is not JSON", () => {
    const receipt = makeReceipt();
    receipt.attestation.payloadCanonical = "{not json";
    const result = verifyReceipt(receipt);
    assert.equal(result.payloadMatches, false);
    assert.equal(result.valid, false);
  });

  it("honours key pinning", () => {
    const pinned = verifyReceipt(makeReceipt(), {
      expectedKeyId: TEST_KEY_ID,
      expectedPublicKeyPem: TEST_PUBLIC_KEY_PEM,
    });
    assert.equal(pinned.keyMatchesExpectation, true);
    assert.equal(pinned.valid, true);

    const wrong = verifyReceipt(makeReceipt(), { expectedKeyId: "ffffffffffffffff" });
    assert.equal(wrong.keyMatchesExpectation, false);
    assert.equal(wrong.valid, false);
  });

  it("compares pinned PEMs ignoring line-ending differences", () => {
    const result = verifyReceipt(makeReceipt(), {
      expectedPublicKeyPem: TEST_PUBLIC_KEY_PEM.replace(/\n/g, "\r\n"),
    });
    assert.equal(result.keyMatchesExpectation, true);
  });

  it("verifies a terminal failure receipt", () => {
    const receipt = makeReceipt({
      status: "failed",
      statusCode: 403,
      contentSha256: null,
      bytesTransferred: 321,
    });
    receipt.status = "failed";
    receipt.statusCode = 403;
    receipt.contentSha256 = null;
    receipt.bytesTransferred = 321;

    const result = verifyReceipt(receipt);
    assert.equal(result.valid, true, result.errors.join("; "));
  });

  it("reports rather than throws when the attestation is missing", () => {
    const result = verifyReceipt({ requestId: "gf_x" } as never);
    assert.equal(result.valid, false);
    assert.deepEqual(result.errors, ["Receipt has no attestation."]);
  });

  it("rejects an unknown payload version", () => {
    const receipt = makeReceipt({ version: "2" as never });
    const result = verifyReceipt(receipt);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes("version")));
  });
});

describe("sha256Hex", () => {
  it("hashes UTF-8 bytes, not code units", () => {
    assert.equal(
      sha256Hex("é"),
      "4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c",
    );
  });
});
