/**
 * The `regionfetch` tool.
 *
 * The result envelope — `{ status, ok, response }` — is the v1 compatibility
 * contract and is preserved verbatim, including the upstream JSON body for
 * non-2xx responses. `verification` is an additive field; consumers reading
 * only the three baseline keys are unaffected.
 */
import { z } from "zod";
import {
  RegionFetchApiError,
  RegionFetchPaymentProviderError,
  RegionFetchProtocolError,
  RegionFetchValidationError,
  type RegionFetchAttestationKey,
  type RegionFetchClient,
  type RegionFetchInput,
  type RegionFetchVerificationResult,
} from "regionfetch";

export const TOOL_NAME = "regionfetch";
export const TOOL_TITLE = "Region Fetch";

export const TOOL_DESCRIPTION = [
  "Fetch a public HTTPS URL as a visitor in a specific country would see it.",
  "Use when page content, pricing, availability, or language may vary by visitor",
  "location, or when you need proof of where a retrieval originated. Returns the",
  "page body plus a signed Ed25519 receipt naming the exit country, supplier, and",
  "content hash. One x402 payment funds one request; the default list price is",
  "$0.02 per call.",
].join(" ");

export const toolInputSchema = {
  url: z
    .string()
    .max(2048)
    .regex(/^https:\/\//, "Must be an https:// URL.")
    .describe("Public HTTPS URL to fetch."),
  country: z
    .enum(["US", "DE", "JP", "BR", "IN"])
    .describe("Country the request should originate from."),
  mode: z
    .enum(["http", "browser"])
    .optional()
    .describe(
      "http for a lightweight request; browser to render JavaScript. Defaults to http.",
    ),
  // L3 is deliberately absent: it is not a supported capability, and an enum is
  // the only thing that reliably stops a model from guessing it.
  max_tier: z
    .enum(["L0", "L1", "L2"])
    .optional()
    .describe(
      "Highest escalation tier to pay for. L0 and L1 use the standard regional " +
        "supplier. L2 permits escalation to a managed unblocker for hard targets " +
        "and costs more. Defaults to L1.",
    ),
};

export const toolOutputSchema = {
  status: z.number().describe("Upstream HTTP status, or a synthetic status for local failures."),
  ok: z.boolean().describe("True only for a 2xx upstream response."),
  response: z.unknown().describe("The upstream JSON body, preserved as sent."),
  verification: z
    .unknown()
    .optional()
    .describe("Local receipt verification result, when a signed receipt was returned."),
};

export interface RegionFetchToolEnvelope {
  status: number;
  ok: boolean;
  response: unknown;
  verification?: RegionFetchVerificationResult & { checkedAgainstDeploymentKey: boolean };
}

export interface ToolDependencies {
  client: RegionFetchClient;
  /** Static-signature mode only. Undefined in wallet mode. */
  paymentSignature?: string | undefined;
  /** Resolves the deployment's published key, for pinning. Cached by the caller. */
  getAttestationKey: () => Promise<RegionFetchAttestationKey | undefined>;
}

/**
 * Run one tool call.
 *
 * Never throws: every outcome becomes an envelope, because an MCP client that
 * receives an exception loses the signed receipt attached to a paid failure.
 */
export async function runRegionFetchTool(
  args: RegionFetchInput,
  deps: ToolDependencies,
): Promise<RegionFetchToolEnvelope> {
  try {
    const result = await deps.client.fetchUrl(args, {
      ...(deps.paymentSignature === undefined
        ? {}
        : { paymentSignature: deps.paymentSignature }),
    });

    const verification = await verify(deps, result.receipt, result.data.body);
    return {
      status: 200,
      ok: true,
      response: result,
      ...(verification === undefined ? {} : { verification }),
    };
  } catch (error) {
    return toErrorEnvelope(error, deps);
  }
}

async function verify(
  deps: ToolDependencies,
  receipt: unknown,
  body?: string,
): Promise<RegionFetchToolEnvelope["verification"]> {
  if (receipt === null || typeof receipt !== "object") return undefined;

  let key: RegionFetchAttestationKey | undefined;
  try {
    key = await deps.getAttestationKey();
  } catch {
    // A key lookup failure must not turn a paid success into a tool error.
    key = undefined;
  }

  const result = await deps.client.verifyReceipt(receipt as never, {
    ...(key === undefined ? {} : { expectedKeyId: key.keyId, expectedPublicKeyPem: key.publicKeyPem }),
    ...(body === undefined ? {} : { responseBody: body }),
  });

  return { ...result, checkedAgainstDeploymentKey: key !== undefined };
}

async function toErrorEnvelope(
  error: unknown,
  deps: ToolDependencies,
): Promise<RegionFetchToolEnvelope> {
  if (error instanceof RegionFetchApiError) {
    // A settled payment that failed terminally still carries a signed receipt.
    // It is evidence the attempt happened — keep it and verify it.
    const verification = error.receipt
      ? await verify(deps, error.receipt)
      : undefined;
    return {
      status: error.status,
      ok: false,
      response: error.body ?? { error: { code: error.code, message: error.message } },
      ...(verification === undefined ? {} : { verification }),
    };
  }

  if (error instanceof RegionFetchValidationError) {
    // Rejected before any payment was created. Reported as 400 so the model
    // sees the same shape it would get from the API.
    return {
      status: 400,
      ok: false,
      response: {
        error: {
          code: "invalid_request",
          message: `${error.message} (rejected locally; no payment was created)`,
        },
      },
    };
  }

  if (error instanceof RegionFetchPaymentProviderError) {
    return {
      status: 402,
      ok: false,
      response: {
        error: {
          code: "payment_provider_failed",
          message: error.message,
        },
      },
    };
  }

  if (error instanceof RegionFetchProtocolError) {
    return {
      status: error.status ?? 502,
      ok: false,
      response: {
        error: { code: "invalid_upstream_response", message: error.message },
      },
    };
  }

  return {
    status: 500,
    ok: false,
    response: {
      error: {
        code: "tool_execution_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    },
  };
}
