/**
 * An x402 payment provider built on the official v2 client.
 *
 * Deliberately kept out of the core entry point. `@x402/core`, `@x402/evm` and
 * `viem` are optional peer dependencies, so a caller who brings their own
 * wallet — or who only verifies receipts — installs nothing extra.
 *
 * Version note: the deployment speaks x402 **v2** (CAIP-2 networks, an `amount`
 * field, the challenge in a `PAYMENT-REQUIRED` header, and a
 * `PAYMENT-SIGNATURE` request header). The unscoped `x402` / `x402-fetch`
 * packages on npm are v1 only and cannot pay this API. Use the scoped
 * `@x402/*` packages at 2.24 or later.
 */
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { registerExactEvmScheme } from "@x402/evm/exact/client";

import { RegionFetchConfigError } from "./errors.js";
import { PAYMENT_SIGNATURE_HEADER, type RegionFetchPaymentProvider } from "./payment.js";

/** The subset of a viem account the x402 exact-EVM scheme actually needs. */
export interface RegionFetchEvmSigner {
  readonly address: `0x${string}`;
  signTypedData(message: {
    domain: Record<string, unknown>;
    types: Record<string, unknown>;
    primaryType: string;
    message: Record<string, unknown>;
  }): Promise<`0x${string}`>;
}

export interface RegionFetchX402ProviderOptions {
  /**
   * A ready signer — typically `privateKeyToAccount(...)` from `viem/accounts`,
   * or any wallet exposing `address` and `signTypedData`.
   */
  signer?: RegionFetchEvmSigner;
  /**
   * A raw EVM private key, converted to a signer with viem.
   *
   * Provided for server-side convenience only. Prefer {@link signer} with a
   * wallet that keeps key material out of your process, and never accept this
   * value from a tool argument, a request body, or model-authored input.
   */
  privateKey?: string;
  /**
   * Per-payment ceiling, as a USD string like `"$0.10"`. `false` removes the
   * cap. Defaults to `"$0.10"` — comfortably above the $0.02 list price and low
   * enough that a misconfigured or hostile deployment cannot drain a wallet.
   */
  maxAmountPerPayment?: string | false;
  /** Optional RPC URL for on-chain reads during payment construction. */
  rpcUrl?: string;
  /** Restrict to specific CAIP-2 networks. Defaults to every EVM network. */
  networks?: string[];
}

const HEX_64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Accept the forms a private key realistically arrives in.
 *
 * Wallet exports frequently omit the `0x` prefix, and a key pasted into a shell
 * or an MCP `env` block often carries a trailing newline or surrounding quotes.
 * Rejecting those is a papercut on the one input a caller cannot debug by
 * printing it, so normalize first and only then validate.
 *
 * Returns the canonical `0x`-prefixed form, or a reason it could not.
 */
export function normalizePrivateKey(
  input: string,
): { key: `0x${string}` } | { error: string } {
  const trimmed = input.trim().replace(/^["']|["']$/g, "").trim();
  if (trimmed === "") return { error: "privateKey is empty." };

  const body = trimmed.replace(/^0[xX]/, "");

  if (!HEX_64_RE.test(body)) {
    // Say what is wrong without ever echoing the value.
    const nonHex = body.replace(/[0-9a-fA-F]/g, "").length;
    if (nonHex > 0) {
      return {
        error:
          `privateKey contains ${nonHex} non-hexadecimal character(s). ` +
          "Expected 64 hex characters, optionally prefixed with 0x. " +
          "(Value withheld.)",
      };
    }
    return {
      error:
        `privateKey has ${body.length} hex characters; a 32-byte key needs 64. ` +
        "(Value withheld.)",
    };
  }

  return { key: `0x${body.toLowerCase()}` };
}

/**
 * Build a payment provider that signs one fresh x402 authorization per request.
 *
 * ```ts
 * const provider = await createX402PaymentProvider({ privateKey: process.env.WALLET_KEY });
 * const client = new RegionFetchClient({ paymentProvider: provider });
 * ```
 */
export async function createX402PaymentProvider(
  options: RegionFetchX402ProviderOptions,
): Promise<RegionFetchPaymentProvider> {
  const signer = await resolveSigner(options);

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: signer as never,
    ...(options.rpcUrl === undefined ? {} : { schemeOptions: { rpcUrl: options.rpcUrl } }),
    ...(options.networks === undefined ? {} : { networks: options.networks as never }),
  });

  const cap = options.maxAmountPerPayment === undefined ? "$0.10" : options.maxAmountPerPayment;
  client.setSpendControls(cap === false ? false : { maxAmountPerPayment: cap as never });

  const httpClient = new x402HTTPClient(client);

  return {
    async createPayment(context) {
      if (!context.paymentRequired) {
        throw new RegionFetchConfigError(
          "No decoded x402 challenge was supplied; refusing to guess payment requirements.",
        );
      }
      const payload = await client.createPaymentPayload(context.paymentRequired as never);
      const headers = httpClient.encodePaymentSignatureHeader(payload);

      const match = Object.entries(headers).find(
        ([name]) => name.toLowerCase() === PAYMENT_SIGNATURE_HEADER.toLowerCase(),
      );
      if (!match || typeof match[1] !== "string" || match[1].length === 0) {
        throw new RegionFetchConfigError(
          `The x402 client did not produce a ${PAYMENT_SIGNATURE_HEADER} header. ` +
            "This usually means the deployment offered only x402 v1 requirements.",
        );
      }
      return match[1];
    },
  };
}

async function resolveSigner(
  options: RegionFetchX402ProviderOptions,
): Promise<RegionFetchEvmSigner> {
  if (options.signer && options.privateKey) {
    throw new RegionFetchConfigError("Pass either signer or privateKey, not both.");
  }
  if (options.signer) return options.signer;

  const privateKey = options.privateKey;
  if (privateKey === undefined) {
    throw new RegionFetchConfigError(
      "createX402PaymentProvider requires either a signer or a privateKey.",
    );
  }
  const normalized = normalizePrivateKey(privateKey);
  if ("error" in normalized) throw new RegionFetchConfigError(normalized.error);

  const { privateKeyToAccount } = await import("viem/accounts");
  return privateKeyToAccount(normalized.key) as unknown as RegionFetchEvmSigner;
}
