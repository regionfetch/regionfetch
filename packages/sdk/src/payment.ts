/**
 * Payment plumbing that is independent of any particular wallet.
 *
 * The SDK never holds key material. It asks a {@link RegionFetchPaymentProvider}
 * for one authorization per request and forwards it. See `./x402.js` for a
 * provider built on the official x402 v2 client.
 */
import { RegionFetchProtocolError } from "./errors.js";
import type { RegionFetchInput, X402PaymentRequired } from "./types.js";

/** The canonical payment header. `X-Payment` is accepted by the server but legacy. */
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";

/** The header carrying the x402 challenge on a 402 response. */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";

export interface RegionFetchPaymentContext {
  /** The exact request the payment will fund. */
  request: RegionFetchInput;
  /** Decoded challenge, when the deployment sent a well-formed one. */
  paymentRequired?: X402PaymentRequired;
  /** Raw `PAYMENT-REQUIRED` header value, still base64. */
  paymentRequiredHeader?: string;
  /** Normalized base URL of the deployment being paid. */
  baseUrl: string;
  /** Absolute URL of the resource being paid for. */
  resourceUrl: string;
}

/**
 * Produces one x402 payment authorization.
 *
 * Implementations must return a fresh authorization per call. One payment funds
 * exactly one durable request; reusing a value across different inputs is a
 * protocol violation, not an optimization.
 */
export interface RegionFetchPaymentProvider {
  createPayment(context: RegionFetchPaymentContext): Promise<string>;
}

/**
 * Decode the base64 `PAYMENT-REQUIRED` header into an x402 challenge.
 *
 * The deployment answers 402 with an empty JSON body and puts the challenge
 * here, so this — not the body — is the only place requirements can be read.
 */
export function decodePaymentRequiredHeader(headerValue: string): X402PaymentRequired {
  let json: string;
  try {
    json = Buffer.from(headerValue, "base64").toString("utf8");
  } catch (cause) {
    throw new RegionFetchProtocolError(
      `PAYMENT-REQUIRED header is not valid base64: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new RegionFetchProtocolError("PAYMENT-REQUIRED header did not decode to JSON.");
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as X402PaymentRequired).accepts)
  ) {
    throw new RegionFetchProtocolError(
      "PAYMENT-REQUIRED header is missing an `accepts` array.",
    );
  }

  return parsed as X402PaymentRequired;
}

/** Read the challenge off a response, returning undefined when absent or malformed. */
export function readPaymentRequired(
  headers: Headers,
): { raw: string; decoded?: X402PaymentRequired } | undefined {
  const raw = headers.get(PAYMENT_REQUIRED_HEADER);
  if (!raw) return undefined;
  try {
    return { raw, decoded: decodePaymentRequiredHeader(raw) };
  } catch {
    return { raw };
  }
}

/** Atomic amount for a requirement, spanning the v2 (`amount`) and v1 (`maxAmountRequired`) spellings. */
export function requirementAmount(requirement: {
  amount?: string;
  maxAmountRequired?: string;
}): string | undefined {
  return requirement.amount ?? requirement.maxAmountRequired;
}

/** One-line description of a challenge, safe to log — carries no authorization. */
export function describePaymentRequired(challenge: X402PaymentRequired): string {
  const options = challenge.accepts
    .map((requirement) => {
      const amount = requirementAmount(requirement) ?? "?";
      return `${requirement.scheme}/${requirement.network} ${amount} ${requirement.asset ?? ""}`.trim();
    })
    .join("; ");
  return `x402 v${challenge.x402Version}: ${options || "no options offered"}`;
}
