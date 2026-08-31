/**
 * Verify a receipt you were handed, without trusting the sender.
 *
 * A receipt is self-describing: it carries the public key that signed it. That
 * alone proves internal consistency, not origin — anyone can mint a
 * self-consistent receipt with their own key. Pin the key, or fetch it from the
 * deployment, to prove the receipt came from Region Fetch.
 *
 *   npx tsx examples/verify-receipt.ts ./receipt.json
 */
import { readFile } from "node:fs/promises";

import { RegionFetchClient, verifyReceipt, type RegionFetchReceipt } from "regionfetch";

const path = process.argv[2];
if (!path) throw new Error("Usage: verify-receipt.ts <receipt.json>");

const receipt = JSON.parse(await readFile(path, "utf8")) as RegionFetchReceipt;

// Independent lookup of the deployment's advertised key.
const client = new RegionFetchClient();
const key = await client.getAttestationKey();

const result = verifyReceipt(receipt, {
  expectedKeyId: key.keyId,
  expectedPublicKeyPem: key.publicKeyPem,
});

console.log("signature valid  ", result.signatureValid);
console.log("payload matches  ", result.payloadMatches);
console.log("receipt fields ok", result.receiptFieldsMatch);
console.log("key as expected  ", result.keyMatchesExpectation);
console.log("overall          ", result.valid);
for (const error of result.errors) console.error(" -", error);

process.exitCode = result.valid ? 0 : 1;
