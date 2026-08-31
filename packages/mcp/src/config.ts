/**
 * Environment configuration for the Region Fetch MCP server.
 *
 * Everything is read from the MCP host's `env` block. Nothing configurable here
 * is ever accepted as a tool argument — a model must not be able to choose the
 * wallet, the spend cap, or the deployment being paid.
 */
import { DEFAULT_BASE_URL, normalizeBaseUrl } from "regionfetch";

export type PaymentMode = "wallet" | "static-signature" | "none";

export interface RegionFetchMcpConfig {
  baseUrl: string;
  paymentMode: PaymentMode;
  /** Present only in wallet mode. Never logged, never surfaced to the model. */
  walletPrivateKey?: string;
  /** Present only in static-signature mode. Funds exactly one tool call. */
  paymentSignature?: string;
  maxAmountPerPayment: string | false;
  rpcUrl?: string;
  timeoutMs: number;
  allowInsecureHttpForDevelopment: boolean;
  /** Deprecated variable names that were actually used, for a startup notice. */
  legacyVariablesUsed: string[];
}

/**
 * Read the first variable that is set, preferring canonical names over the
 * `GEOFETCH_*` names the pre-rename adapter used.
 */
function readEnv(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  legacyFrom: number,
  legacyVariablesUsed: string[],
): string | undefined {
  for (const [index, name] of names.entries()) {
    const value = env[name];
    if (value !== undefined && value.trim() !== "") {
      if (index >= legacyFrom) legacyVariablesUsed.push(name);
      return value.trim();
    }
  }
  return undefined;
}

function parseBoolean(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RegionFetchMcpConfig {
  const legacyVariablesUsed: string[] = [];

  const rawBaseUrl =
    readEnv(env, ["REGION_FETCH_BASE_URL", "GEOFETCH_BASE_URL"], 1, legacyVariablesUsed) ??
    DEFAULT_BASE_URL;

  const allowInsecureHttpForDevelopment = parseBoolean(
    env["REGION_FETCH_ALLOW_INSECURE_HTTP"],
  );

  const baseUrl = normalizeBaseUrl(rawBaseUrl, { allowInsecureHttpForDevelopment });

  const walletPrivateKey = readEnv(
    env,
    ["REGION_FETCH_WALLET_PRIVATE_KEY", "REGION_FETCH_PRIVATE_KEY"],
    2,
    legacyVariablesUsed,
  );

  const paymentSignature = readEnv(
    env,
    [
      "REGION_FETCH_PAYMENT_SIGNATURE",
      "GEOFETCH_PAYMENT_SIGNATURE",
      "PAYMENT_SIGNATURE",
    ],
    1,
    legacyVariablesUsed,
  );

  const rawMax = env["REGION_FETCH_MAX_PAYMENT"]?.trim();
  const maxAmountPerPayment: string | false =
    rawMax === undefined || rawMax === "" ? "$0.10" : rawMax.toLowerCase() === "off" ? false : rawMax;

  const rawTimeout = env["REGION_FETCH_TIMEOUT_MS"]?.trim();
  const parsedTimeout = rawTimeout === undefined ? Number.NaN : Number.parseInt(rawTimeout, 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 120_000;

  const rpcUrl = env["REGION_FETCH_RPC_URL"]?.trim() || undefined;

  // Wallet mode wins. A static signature funds exactly one request, so it is
  // only ever a testing fallback — never the better choice when both are set.
  const paymentMode: PaymentMode = walletPrivateKey
    ? "wallet"
    : paymentSignature
      ? "static-signature"
      : "none";

  return {
    baseUrl,
    paymentMode,
    ...(walletPrivateKey === undefined ? {} : { walletPrivateKey }),
    ...(paymentSignature === undefined ? {} : { paymentSignature }),
    maxAmountPerPayment,
    ...(rpcUrl === undefined ? {} : { rpcUrl }),
    timeoutMs,
    allowInsecureHttpForDevelopment,
    legacyVariablesUsed,
  };
}

/** A startup summary safe to write to stderr. Carries no key material. */
export function describeConfig(config: RegionFetchMcpConfig): string[] {
  const lines = [
    `Region Fetch MCP server`,
    `  base URL      ${config.baseUrl}`,
    `  payment mode  ${config.paymentMode}`,
  ];
  if (config.paymentMode === "wallet") {
    lines.push(
      `  spend cap     ${config.maxAmountPerPayment === false ? "disabled" : config.maxAmountPerPayment} per payment`,
    );
  }
  if (config.paymentMode === "static-signature") {
    lines.push(
      "  note          A static signature funds one request. The second tool call will fail.",
      "                Set REGION_FETCH_WALLET_PRIVATE_KEY for a server that keeps working.",
    );
  }
  if (config.paymentMode === "none") {
    lines.push(
      "  note          No payment configured. Every tool call will return the deployment's 402.",
    );
  }
  if (config.legacyVariablesUsed.length > 0) {
    lines.push(
      `  deprecated    ${config.legacyVariablesUsed.join(", ")} — rename to the REGION_FETCH_* equivalents.`,
    );
  }
  return lines;
}
