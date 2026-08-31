/**
 * Wallet mode: the SDK signs a fresh authorization per request.
 *
 * Requires the x402 v2 client stack:
 *   npm install regionfetch @x402/core @x402/evm viem
 *
 * The unscoped `x402` and `x402-fetch` packages are protocol v1 and cannot pay
 * this API — they read the challenge from the response body, send `X-PAYMENT`,
 * and reject a CAIP-2 network like `eip155:8453`.
 *
 *   REGION_FETCH_WALLET_PRIVATE_KEY=0x... npx tsx examples/wallet-provider.ts
 */
import { RegionFetchClient } from "regionfetch";
import { createX402PaymentProvider } from "regionfetch/x402";

const privateKey = process.env["REGION_FETCH_WALLET_PRIVATE_KEY"];
if (!privateKey) {
  throw new Error("Set REGION_FETCH_WALLET_PRIVATE_KEY to a funded Base wallet key.");
}

const paymentProvider = await createX402PaymentProvider({
  privateKey,
  // A per-payment ceiling well above the $0.02 list price but low enough that a
  // misconfigured or hostile deployment cannot drain the wallet.
  maxAmountPerPayment: "$0.10",
});

const client = new RegionFetchClient({
  paymentProvider,
  // Browser mode renders a real page; give it room.
  timeoutMs: 120_000,
});

const result = await client.fetchUrl({
  url: "https://example.com/",
  country: "JP",
  mode: "browser",
});

const verification = await client.verifyReceipt(result.receipt, {
  responseBody: result.data.body,
});

console.log("request     ", result.receipt.requestId);
console.log("supplier    ", result.receipt.supplier);
console.log("exit country", result.receipt.attestation.payload.country);
console.log("verified    ", verification.valid, verification.errors);
