/**
 * Explicit payment: you already hold an x402 authorization.
 *
 * This is the minimum integration. Note that one authorization funds exactly
 * one request — the second call below would fail with 409 or 402.
 *
 *   REGION_FETCH_PAYMENT_SIGNATURE=... npx tsx examples/explicit-payment.ts
 */
import { RegionFetchApiError, RegionFetchClient } from "regionfetch";

const paymentSignature = process.env["REGION_FETCH_PAYMENT_SIGNATURE"];
if (!paymentSignature) {
  throw new Error("Set REGION_FETCH_PAYMENT_SIGNATURE to a fresh x402 authorization.");
}

const client = new RegionFetchClient();

try {
  const result = await client.fetchUrl(
    { url: "https://example.com/", country: "DE", mode: "http" },
    { paymentSignature },
  );

  console.log("request", result.receipt.requestId);
  console.log("exit country", result.receipt.attestation.payload.country);
  console.log("bytes", result.receipt.bytesTransferred);
  console.log(result.data.body.slice(0, 200));
} catch (error) {
  if (error instanceof RegionFetchApiError && error.isPaidFailure) {
    // Payment settled and the attempt failed terminally. The receipt is the
    // evidence that it happened — store it rather than discarding it.
    console.error("paid failure", error.code, error.receipt?.requestId);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
