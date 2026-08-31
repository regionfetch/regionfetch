import type { RegionFetchReceipt, X402PaymentRequired } from "./types.js";

/** Base class for every error this SDK throws deliberately. */
export class RegionFetchError extends Error {
  override readonly name: string = "RegionFetchError";
}

/** Input rejected locally, before any network call or payment was made. */
export class RegionFetchValidationError extends RegionFetchError {
  override readonly name = "RegionFetchValidationError";
  readonly field: string | undefined;

  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

/** Configuration the SDK cannot proceed without (bad base URL, missing provider). */
export class RegionFetchConfigError extends RegionFetchError {
  override readonly name = "RegionFetchConfigError";
}

export interface RegionFetchApiErrorInit {
  status: number;
  code: string;
  message: string;
  receipt?: RegionFetchReceipt | undefined;
  replayed?: boolean | undefined;
  responseHeaders?: Headers | undefined;
  requestId?: string | undefined;
  body?: unknown;
}

/**
 * A non-2xx response from the Region Fetch API.
 *
 * When {@link receipt} is present the payment was settled and the attempt
 * reached a terminal outcome. That receipt is the evidence the paid attempt
 * happened — persist it. Never discard it just because the call "failed".
 */
export class RegionFetchApiError extends RegionFetchError {
  override readonly name: string = "RegionFetchApiError";
  readonly status: number;
  readonly code: string;
  readonly receipt: RegionFetchReceipt | undefined;
  readonly replayed: boolean | undefined;
  readonly responseHeaders: Headers;
  readonly requestId: string | undefined;
  readonly body: unknown;

  constructor(init: RegionFetchApiErrorInit) {
    super(init.message);
    this.status = init.status;
    this.code = init.code;
    this.receipt = init.receipt;
    this.replayed = init.replayed;
    this.responseHeaders = init.responseHeaders ?? new Headers();
    this.requestId = init.requestId ?? init.receipt?.requestId;
    this.body = init.body;
  }

  /** True when payment settled and a signed terminal receipt is attached. */
  get isPaidFailure(): boolean {
    return this.receipt !== undefined;
  }
}

/**
 * HTTP 402. The deployment returns an empty JSON body and carries the challenge
 * in the `PAYMENT-REQUIRED` header, so {@link paymentRequired} may be present
 * even though the body held nothing useful.
 */
export class RegionFetchPaymentRequiredError extends RegionFetchApiError {
  override readonly name = "RegionFetchPaymentRequiredError";
  /** Raw, still base64-encoded `PAYMENT-REQUIRED` header value, when sent. */
  readonly paymentRequiredHeader: string | undefined;
  /** Decoded challenge, when the header was present and well-formed. */
  readonly paymentRequired: X402PaymentRequired | undefined;

  constructor(
    init: RegionFetchApiErrorInit & {
      paymentRequiredHeader?: string | undefined;
      paymentRequired?: X402PaymentRequired | undefined;
    },
  ) {
    super(init);
    this.paymentRequiredHeader = init.paymentRequiredHeader;
    this.paymentRequired = init.paymentRequired;
  }
}

/** The API replied with something that was not the JSON shape we expect. */
export class RegionFetchProtocolError extends RegionFetchError {
  override readonly name = "RegionFetchProtocolError";
  readonly status: number | undefined;
  readonly bodyPreview: string | undefined;

  constructor(message: string, options?: { status?: number; bodyPreview?: string }) {
    super(message);
    this.status = options?.status;
    this.bodyPreview = options?.bodyPreview;
  }
}

/** A payment provider was asked for an authorization and could not produce one. */
export class RegionFetchPaymentProviderError extends RegionFetchError {
  override readonly name = "RegionFetchPaymentProviderError";
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}
