import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { normalizePrivateKey } from "../src/x402.js";

const HEX = randomBytes(32).toString("hex");

describe("normalizePrivateKey", () => {
  it("accepts the forms a key actually arrives in", () => {
    // Wallet exports often omit 0x; shells and MCP env blocks add whitespace
    // and sometimes keep the quotes. All of these are the same key.
    for (const input of [
      `0x${HEX}`,
      HEX,
      `0x${HEX}\n`,
      `  0x${HEX}  `,
      `0X${HEX}`,
      `"0x${HEX}"`,
      `'0x${HEX}'`,
      `0x${HEX.toUpperCase()}`,
    ]) {
      const result = normalizePrivateKey(input);
      assert.ok("key" in result, `expected ${JSON.stringify(input.slice(0, 6))}… to be accepted`);
      assert.equal(result.key, `0x${HEX.toLowerCase()}`);
    }
  });

  it("reports why a key is wrong without echoing it", () => {
    const short = normalizePrivateKey("0xdeadbeef");
    assert.ok("error" in short);
    assert.match(short.error, /8 hex characters/);
    assert.ok(!short.error.includes("deadbeef"), "the value must never appear in the message");

    const nonHex = normalizePrivateKey(`0x${"z".repeat(64)}`);
    assert.ok("error" in nonHex);
    assert.match(nonHex.error, /non-hexadecimal/);
    assert.ok(!nonHex.error.includes("zzz"));

    const empty = normalizePrivateKey("   ");
    assert.ok("error" in empty);
    assert.match(empty.error, /empty/);
  });

  it("recognizes an address pasted in place of a key", () => {
    // The most common mix-up: a wallet's copy button yields the address.
    const result = normalizePrivateKey("0x000000000000000000000000000000000000dEaD");
    assert.ok("error" in result);
    assert.match(result.error, /wallet address/);
    assert.match(result.error, /Settings > Security/);
  });

  it("rejects a seed phrase pasted in place of a key", () => {
    const result = normalizePrivateKey(
      "witch collapse practice feed shame open despair creek road again ice least",
    );
    assert.ok("error" in result);
    assert.match(result.error, /non-hexadecimal/);
    assert.ok(!result.error.includes("witch"), "a mnemonic must never be echoed");
  });

  it("is case-insensitive but always returns lowercase", () => {
    const upper = normalizePrivateKey(`0X${HEX.toUpperCase()}`);
    assert.ok("key" in upper);
    assert.equal(upper.key, upper.key.toLowerCase());
  });
});
