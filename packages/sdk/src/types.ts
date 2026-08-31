/**
 * Public wire types for the Region Fetch API.
 *
 * These mirror the deployed contract at https://regionfetch.dev. Where the
 * runtime and the published OpenAPI document disagree, the runtime wins and the
 * divergence is called out in a comment.
 */

/** Countries the deployment can originate a retrieval from. */
export const REGION_FETCH_COUNTRIES = ["US", "DE", "JP", "BR", "IN"] as const;
export type RegionFetchCountry = (typeof REGION_FETCH_COUNTRIES)[number];

/** Retrieval modes. `http` is a direct proxied GET; `browser` renders in Chromium. */
export const REGION_FETCH_MODES = ["http", "browser"] as const;
export type RegionFetchMode = (typeof REGION_FETCH_MODES)[number];

/** Maximum accepted target URL length, enforced by the server. */
export const REGION_FETCH_MAX_URL_LENGTH = 2048;

export interface RegionFetchInput {
  /** Public HTTPS URL, at most {@link REGION_FETCH_MAX_URL_LENGTH} characters. */
  url: string;
  /** Country the retrieval should originate from. */
  country: RegionFetchCountry;
  /** Defaults to `"http"` server-side. */
  mode?: RegionFetchMode;
}

export interface RegionFetchData {
  /** The originally requested URL, not the post-redirect URL. */
  url: string;
  contentType: string | null;
  body: string;
}

export type RegionFetchTerminalStatus = "succeeded" | "failed";

/** The structured, signed attestation. This is the canonical source of receipt fields. */
export interface RegionFetchAttestationPayload {
  version: "1";
  requestId: string;
  paymentId: string;
  targetUrl: string;
  finalUrl: string | null;
  country: RegionFetchCountry;
  mode: RegionFetchMode;
  supplier: string;
  status: RegionFetchTerminalStatus;
  statusCode: number | null;
  bytesTransferred: number;
  contentSha256: string | null;
  completedAt: string;
}

export interface RegionFetchAttestation {
  algorithm: "Ed25519";
  keyId: string;
  publicKeyPem: string;
  payload: RegionFetchAttestationPayload;
  /**
   * The exact JSON string whose UTF-8 bytes were signed.
   *
   * Verification MUST use this string. Re-serializing {@link payload} can
   * produce different bytes and will fail or, worse, mask a mismatch.
   */
  payloadCanonical: string;
  /** Base64url-encoded Ed25519 signature over the UTF-8 bytes of `payloadCanonical`. */
  signature: string;
}

/**
 * Top-level receipt fields are convenience duplicates of
 * `attestation.payload`. The server builds initial and replay/status responses
 * through different code paths, so `paymentId`, `targetUrl` and `version` may be
 * absent here even though they are always present in the signed payload.
 * Read attested values from `attestation.payload`.
 */
export interface RegionFetchReceipt {
  requestId: string;
  supplier: string;
  country: RegionFetchCountry;
  mode: RegionFetchMode;
  status: RegionFetchTerminalStatus;
  statusCode: number | null;
  finalUrl: string | null;
  bytesTransferred: number;
  contentSha256: string | null;
  completedAt: string;
  attestation: RegionFetchAttestation;
  paymentId?: string;
  targetUrl?: string;
  version?: string;
}

export interface RegionFetchSuccess {
  data: RegionFetchData;
  receipt: RegionFetchReceipt;
  /**
   * Set when the same settled payment was submitted again after completion and
   * the stored terminal result was returned instead of a new retrieval.
   * Undeclared in OpenAPI as of the 0.1.0 contract snapshot.
   */
  replayed?: boolean;
}

export interface RegionFetchAttestationKey {
  algorithm: "Ed25519";
  keyId: string;
  publicKeyPem: string;
}

export interface RegionFetchStatusSuccess {
  status: "succeeded";
  data: RegionFetchData;
  receipt: RegionFetchReceipt;
}

/**
 * A stored terminal failure. The status endpoint returns HTTP 200 for this —
 * the failure detail lives in the signed receipt, not in an `error` envelope.
 */
export interface RegionFetchStatusFailure {
  status: "failed";
  receipt: RegionFetchReceipt;
}

export interface RegionFetchPending {
  requestId: string;
  status: "settling" | "executing";
  message: string;
}

/**
 * Supplier execution may have happened but its terminal result was not
 * persisted. The server will not re-run the retrieval, because doing so after
 * settlement could duplicate an external effect. Reconcile against the recorded
 * settlement transaction rather than paying again.
 */
export interface RegionFetchUnresolved {
  requestId: string;
  status: "unresolved";
  message: string;
}

export type RegionFetchRequestState =
  | RegionFetchStatusSuccess
  | RegionFetchStatusFailure
  | RegionFetchPending
  | RegionFetchUnresolved;

export interface RegionFetchErrorBody {
  error: { code: string; message: string };
}

/** One entry of the `accepts` array in an x402 payment challenge. */
export interface X402PaymentRequirement {
  scheme: string;
  /** CAIP-2 in x402 v2 (`eip155:8453`); a bare chain name in v1 (`base`). */
  network: string;
  /** Atomic amount in x402 v2. */
  amount?: string;
  /** Atomic amount in x402 v1. */
  maxAmountRequired?: string;
  asset?: string;
  payTo?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A decoded x402 payment challenge, from the `PAYMENT-REQUIRED` header. */
export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource?: { url?: string; description?: string; mimeType?: string };
  accepts: X402PaymentRequirement[];
  [key: string]: unknown;
}
