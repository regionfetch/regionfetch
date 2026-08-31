import {
  RegionFetchApiError,
  RegionFetchConfigError,
  RegionFetchPaymentProviderError,
  RegionFetchPaymentRequiredError,
  RegionFetchProtocolError,
} from "./errors.js";
import {
  PAYMENT_SIGNATURE_HEADER,
  readPaymentRequired,
  type RegionFetchPaymentProvider,
} from "./payment.js";
import { redactHeaders } from "./redact.js";
import type {
  RegionFetchAttestationKey,
  RegionFetchInput,
  RegionFetchReceipt,
  RegionFetchRequestState,
  RegionFetchSuccess,
} from "./types.js";
import {
  DEFAULT_BASE_URL,
  endpointUrl,
  normalizeBaseUrl,
  validateInput,
  validateRequestId,
} from "./validate.js";
import type {
  RegionFetchVerificationResult,
  RegionFetchVerifyOptions,
} from "./verify.js";

export interface RegionFetchRetryPolicy {
  /** Additional attempts after the first. `0` disables retrying. */
  maxRetries: number;
  /** First backoff delay in milliseconds; doubles per attempt. */
  baseDelayMs: number;
  /** Upper bound on any single backoff delay. */
  maxDelayMs: number;
  /**
   * Retry pre-execution 503s (`payment_unavailable`, `fetch_unavailable`).
   * Off by default: a 503 after settlement may have begun leaves the outcome
   * uncertain, and blind retries make reconciliation harder.
   */
  retryOnServiceUnavailable: boolean;
}

export const DEFAULT_RETRY_POLICY: RegionFetchRetryPolicy = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  retryOnServiceUnavailable: false,
};

export interface RegionFetchDiagnostic {
  phase: "request" | "response" | "retry" | "payment";
  method: string;
  url: string;
  attempt: number;
  status?: number;
  /** Already redacted. Never contains a payment signature. */
  headers?: Record<string, string>;
  message?: string;
}

export interface RegionFetchClientOptions {
  /** Deployment origin. Defaults to `https://regionfetch.dev`. */
  baseUrl?: string;
  /** Supplies one x402 authorization per paid request. */
  paymentProvider?: RegionFetchPaymentProvider;
  /** Injectable fetch, for tests and custom agents. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Browser-mode retrievals are slow; default 120s. */
  timeoutMs?: number;
  /** Appended to the SDK's own User-Agent. */
  userAgent?: string;
  /** Permit an http:// base URL. Development only. */
  allowInsecureHttpForDevelopment?: boolean;
  retry?: Partial<RegionFetchRetryPolicy>;
  /** Receives redacted request/response diagnostics. */
  onDiagnostic?: (event: RegionFetchDiagnostic) => void;
}

export interface RegionFetchCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface RegionFetchFetchOptions extends RegionFetchCallOptions {
  /**
   * A pre-made x402 authorization. Takes precedence over `paymentProvider`.
   *
   * One signature funds one durable request. Reusing it for a *different* body
   * is rejected by the deployment; resending the *identical* body after an
   * ambiguous network failure is the correct recovery.
   */
  paymentSignature?: string;
}

const SDK_VERSION = "0.1.0";
const MAX_BODY_PREVIEW = 400;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractReceipt(body: unknown): RegionFetchReceipt | undefined {
  if (isRecord(body) && isRecord(body.receipt)) {
    return body.receipt as unknown as RegionFetchReceipt;
  }
  return undefined;
}

function extractErrorEnvelope(body: unknown): { code: string; message: string } | undefined {
  if (isRecord(body) && isRecord(body.error)) {
    const { code, message } = body.error;
    if (typeof code === "string" && typeof message === "string") return { code, message };
  }
  return undefined;
}

interface RawResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export class RegionFetchClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly paymentProvider: RegionFetchPaymentProvider | undefined;
  private readonly timeoutMs: number;
  private readonly userAgent: string;
  private readonly retryPolicy: RegionFetchRetryPolicy;
  private readonly onDiagnostic: ((event: RegionFetchDiagnostic) => void) | undefined;

  constructor(options: RegionFetchClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL, {
      ...(options.allowInsecureHttpForDevelopment === undefined
        ? {}
        : { allowInsecureHttpForDevelopment: options.allowInsecureHttpForDevelopment }),
    });

    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new RegionFetchConfigError(
        "No fetch implementation available. Pass options.fetch on Node runtimes without a global fetch.",
      );
    }
    this.fetchImpl = fetchImpl;
    this.paymentProvider = options.paymentProvider;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.userAgent = options.userAgent
      ? `regionfetch/${SDK_VERSION} ${options.userAgent}`
      : `regionfetch/${SDK_VERSION}`;
    this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retry };
    this.onDiagnostic = options.onDiagnostic;
  }

  /** Liveness only. A healthy process may still lack payment, supplier, or signing configuration. */
  async health(options: RegionFetchCallOptions = {}): Promise<{ status: string }> {
    const response = await this.send("GET", "/api/healthz", undefined, undefined, options, 1);
    if (response.status !== 200) throw this.toApiError(response);
    if (!isRecord(response.body) || typeof response.body.status !== "string") {
      throw new RegionFetchProtocolError("Health response did not contain a status string.", {
        status: response.status,
        bodyPreview: response.text.slice(0, MAX_BODY_PREVIEW),
      });
    }
    return { status: response.body.status };
  }

  /** The deployment's active Ed25519 verification key. */
  async getAttestationKey(
    options: RegionFetchCallOptions = {},
  ): Promise<RegionFetchAttestationKey> {
    const response = await this.send(
      "GET",
      "/api/attestation-key",
      undefined,
      undefined,
      options,
      1,
    );
    if (response.status !== 200) throw this.toApiError(response);
    const body = response.body;
    if (
      !isRecord(body) ||
      body.algorithm !== "Ed25519" ||
      typeof body.keyId !== "string" ||
      typeof body.publicKeyPem !== "string"
    ) {
      throw new RegionFetchProtocolError("Attestation key response was malformed.", {
        status: response.status,
        bodyPreview: response.text.slice(0, MAX_BODY_PREVIEW),
      });
    }
    return {
      algorithm: "Ed25519",
      keyId: body.keyId,
      publicKeyPem: body.publicKeyPem,
    };
  }

  /**
   * Execute one paid regional fetch.
   *
   * Input is validated locally first. That is load-bearing rather than
   * cosmetic: the deployment's payment gate runs ahead of body validation, so
   * an invalid country would otherwise cost a payment authorization before the
   * server rejected it.
   */
  async fetchUrl(
    input: RegionFetchInput,
    options: RegionFetchFetchOptions = {},
  ): Promise<RegionFetchSuccess> {
    const body = validateInput(input);
    const path = "/api/fetch";

    if (options.paymentSignature !== undefined) {
      const response = await this.sendPaid(path, body, options.paymentSignature, options);
      return this.toFetchSuccess(response);
    }

    // Unpaid probe. Expected to answer 402 with the challenge in a header.
    const challengeResponse = await this.send("POST", path, body, undefined, options, 1);

    if (challengeResponse.status === 200) {
      // A deployment configured without a paywall. Unusual, but valid.
      return this.toFetchSuccess(challengeResponse);
    }
    if (challengeResponse.status !== 402) {
      throw this.toApiError(challengeResponse);
    }

    const challenge = readPaymentRequired(challengeResponse.headers);
    if (!this.paymentProvider) {
      throw this.toPaymentRequiredError(challengeResponse, challenge);
    }
    if (!challenge?.decoded) {
      // Without requirements there is nothing honest to sign. Inventing them
      // from a hardcoded default price risks paying the wrong amount or chain.
      throw this.toPaymentRequiredError(
        challengeResponse,
        challenge,
        "The deployment returned 402 without usable payment requirements, so no payment was created.",
      );
    }

    let paymentSignature: string;
    try {
      paymentSignature = await this.paymentProvider.createPayment({
        request: body,
        paymentRequired: challenge.decoded,
        paymentRequiredHeader: challenge.raw,
        baseUrl: this.baseUrl,
        resourceUrl: endpointUrl(this.baseUrl, path).toString(),
      });
    } catch (cause) {
      throw new RegionFetchPaymentProviderError(
        `Payment provider failed to create an authorization: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      );
    }
    if (typeof paymentSignature !== "string" || paymentSignature.length === 0) {
      throw new RegionFetchPaymentProviderError(
        "Payment provider returned an empty authorization.",
      );
    }

    this.emit({
      phase: "payment",
      method: "POST",
      url: endpointUrl(this.baseUrl, path).toString(),
      attempt: 1,
      message: "Created one x402 authorization for this request.",
    });

    const paid = await this.sendPaid(path, body, paymentSignature, options);
    return this.toFetchSuccess(paid);
  }

  /**
   * Look up a request by id — after a connection drop, an uncertain POST, or to
   * poll a request still in flight.
   */
  async getRequest(
    requestId: string,
    options: RegionFetchCallOptions = {},
  ): Promise<RegionFetchRequestState> {
    const id = validateRequestId(requestId);
    const response = await this.send(
      "GET",
      `/api/fetch/${encodeURIComponent(id)}`,
      undefined,
      undefined,
      options,
      1,
    );

    if (response.status === 200 || response.status === 202) {
      if (isRecord(response.body) && typeof response.body.status === "string") {
        return response.body as unknown as RegionFetchRequestState;
      }
      throw new RegionFetchProtocolError("Request status response was malformed.", {
        status: response.status,
        bodyPreview: response.text.slice(0, MAX_BODY_PREVIEW),
      });
    }

    // `unresolved` arrives as 503 with a status field rather than an error envelope.
    if (
      response.status === 503 &&
      isRecord(response.body) &&
      response.body.status === "unresolved"
    ) {
      return response.body as unknown as RegionFetchRequestState;
    }

    throw this.toApiError(response);
  }

  /** Verify a receipt. Node-only; loads `node:crypto` on demand. */
  async verifyReceipt(
    receipt: RegionFetchReceipt,
    options: RegionFetchVerifyOptions = {},
  ): Promise<RegionFetchVerificationResult> {
    const { verifyReceipt } = await import("./verify.js");
    return verifyReceipt(receipt, options);
  }

  // ---------------------------------------------------------------- internals

  private async sendPaid(
    path: string,
    body: unknown,
    paymentSignature: string,
    options: RegionFetchFetchOptions,
  ): Promise<RawResponse> {
    // Retries here deliberately reuse the same authorization. A fresh payment
    // for the same logical fetch would double-spend.
    let attempt = 0;
    for (;;) {
      attempt += 1;
      const response = await this.send(
        "POST",
        path,
        body,
        { [PAYMENT_SIGNATURE_HEADER]: paymentSignature },
        options,
        attempt,
      );
      if (response.status === 200) return response;

      const retryDelay = this.retryDelayFor(response, attempt);
      if (retryDelay === undefined) throw this.toApiError(response);

      this.emit({
        phase: "retry",
        method: "POST",
        url: endpointUrl(this.baseUrl, path).toString(),
        attempt,
        status: response.status,
        message: `Retrying the identical request with the same authorization in ${retryDelay}ms.`,
      });
      await sleep(retryDelay);
    }
  }

  /** Returns a delay when the response is safely retryable, otherwise undefined. */
  private retryDelayFor(response: RawResponse, attempt: number): number | undefined {
    if (attempt > this.retryPolicy.maxRetries) return undefined;

    const retryable =
      response.status === 409 ||
      response.status === 429 ||
      (response.status === 503 && this.retryPolicy.retryOnServiceUnavailable);
    if (!retryable) return undefined;

    // A settled-but-unpersisted outcome must be reconciled, never retried.
    if (isRecord(response.body) && response.body.status === "unresolved") return undefined;

    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number.parseInt(retryAfter, 10);
      if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(seconds * 1000, this.retryPolicy.maxDelayMs);
      }
    }

    const backoff = Math.min(
      this.retryPolicy.baseDelayMs * 2 ** (attempt - 1),
      this.retryPolicy.maxDelayMs,
    );
    return Math.round(backoff * (0.5 + Math.random() * 0.5));
  }

  private async send(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    extraHeaders: Record<string, string> | undefined,
    options: RegionFetchCallOptions,
    attempt: number,
  ): Promise<RawResponse> {
    const url = endpointUrl(this.baseUrl, path);
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": this.userAgent,
      ...extraHeaders,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const signal = combineSignals([options.signal, AbortSignal.timeout(timeoutMs)]);

    this.emit({
      phase: "request",
      method,
      url: url.toString(),
      attempt,
      headers: redactHeaders(headers),
    });

    const response = await this.fetchImpl(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    });

    const text = await response.text();
    let parsed: unknown;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        // A base URL pointing at the marketing site returns the SPA's HTML with
        // HTTP 200. Say so plainly instead of failing somewhere further down.
        throw new RegionFetchProtocolError(
          `Expected JSON from ${url.toString()} but received ${response.headers.get("content-type") ?? "an unknown content type"}. Check that baseUrl points at a Region Fetch deployment.`,
          { status: response.status, bodyPreview: text.slice(0, MAX_BODY_PREVIEW) },
        );
      }
    }

    this.emit({
      phase: "response",
      method,
      url: url.toString(),
      attempt,
      status: response.status,
      headers: redactHeaders(response.headers),
    });

    return { status: response.status, headers: response.headers, body: parsed, text };
  }

  private toFetchSuccess(response: RawResponse): RegionFetchSuccess {
    const body = response.body;
    if (!isRecord(body) || !isRecord(body.data) || !isRecord(body.receipt)) {
      throw new RegionFetchProtocolError(
        "Fetch response did not contain both `data` and `receipt`.",
        { status: response.status, bodyPreview: response.text.slice(0, MAX_BODY_PREVIEW) },
      );
    }
    return body as unknown as RegionFetchSuccess;
  }

  private toPaymentRequiredError(
    response: RawResponse,
    challenge: { raw: string; decoded?: unknown } | undefined,
    message?: string,
  ): RegionFetchPaymentRequiredError {
    const envelope = extractErrorEnvelope(response.body);
    return new RegionFetchPaymentRequiredError({
      status: response.status,
      code: envelope?.code ?? "payment_required",
      message:
        message ??
        envelope?.message ??
        "Payment is required. Supply a paymentSignature or configure a paymentProvider.",
      responseHeaders: response.headers,
      body: response.body,
      ...(challenge === undefined ? {} : { paymentRequiredHeader: challenge.raw }),
      ...(challenge?.decoded === undefined
        ? {}
        : { paymentRequired: challenge.decoded as never }),
    });
  }

  private toApiError(response: RawResponse): RegionFetchApiError {
    if (response.status === 402) {
      return this.toPaymentRequiredError(response, readPaymentRequired(response.headers));
    }

    const envelope = extractErrorEnvelope(response.body);
    const receipt = extractReceipt(response.body);
    const replayed =
      isRecord(response.body) && typeof response.body.replayed === "boolean"
        ? response.body.replayed
        : undefined;

    return new RegionFetchApiError({
      status: response.status,
      code: envelope?.code ?? `http_${response.status}`,
      message: envelope?.message ?? `Region Fetch returned HTTP ${response.status}.`,
      responseHeaders: response.headers,
      body: response.body,
      ...(receipt === undefined ? {} : { receipt }),
      ...(replayed === undefined ? {} : { replayed }),
    });
  }

  private emit(event: RegionFetchDiagnostic): void {
    if (!this.onDiagnostic) return;
    try {
      this.onDiagnostic(event);
    } catch {
      // A broken diagnostic sink must never fail a paid request.
    }
  }
}
