import { RegionFetchConfigError, RegionFetchValidationError } from "./errors.js";
import {
  REGION_FETCH_COUNTRIES,
  REGION_FETCH_MAX_URL_LENGTH,
  REGION_FETCH_MODES,
  type RegionFetchCountry,
  type RegionFetchInput,
  type RegionFetchMode,
} from "./types.js";

/** The canonical production origin. */
export const DEFAULT_BASE_URL = "https://regionfetch.dev";

const ALLOWED_INPUT_KEYS = new Set(["url", "country", "mode"]);

/**
 * Normalize a base URL to a bare origin.
 *
 * Accepts `https://host`, `https://host/`, and `https://host/api` so that a
 * value copied out of a curl example still works, and returns the origin with
 * no trailing slash. Endpoint paths are then built with `new URL()`.
 */
export function normalizeBaseUrl(
  baseUrl: string,
  options: { allowInsecureHttpForDevelopment?: boolean } = {},
): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new RegionFetchConfigError(`Invalid baseUrl: ${JSON.stringify(baseUrl)}`);
  }

  if (parsed.protocol !== "https:") {
    const insecureAllowed =
      options.allowInsecureHttpForDevelopment === true && parsed.protocol === "http:";
    if (!insecureAllowed) {
      throw new RegionFetchConfigError(
        `baseUrl must use https (got ${parsed.protocol}). ` +
          "Set allowInsecureHttpForDevelopment to use http against a local deployment.",
      );
    }
  }

  if (parsed.username || parsed.password) {
    throw new RegionFetchConfigError("baseUrl must not embed credentials.");
  }

  let path = parsed.pathname.replace(/\/+$/, "");
  if (path.toLowerCase().endsWith("/api")) {
    path = path.slice(0, -"/api".length);
  }
  return `${parsed.origin}${path}`;
}

/** Build an absolute endpoint URL against a normalized base. */
export function endpointUrl(normalizedBaseUrl: string, path: string): URL {
  return new URL(`${normalizedBaseUrl}${path}`);
}

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
];

function looksPrivate(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

/**
 * Validate a fetch input locally, before any payment is created.
 *
 * This matters more than ordinary input validation would: the deployment's
 * payment gate runs *ahead* of body validation, so an unpaid request with a bad
 * country still answers 402. Without this check a caller would mint a payment
 * authorization for a request the server then rejects with 400.
 *
 * The server remains authoritative — it resolves DNS and enforces the real
 * public-target policy. This is an early, cheap filter, not a security boundary.
 */
export function validateInput(input: RegionFetchInput): {
  url: string;
  country: RegionFetchCountry;
  mode?: RegionFetchMode;
} {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new RegionFetchValidationError("Fetch input must be an object.");
  }

  for (const key of Object.keys(input)) {
    if (!ALLOWED_INPUT_KEYS.has(key)) {
      throw new RegionFetchValidationError(
        `Unknown field ${JSON.stringify(key)}. The API rejects unknown fields.`,
        key,
      );
    }
  }

  const { url, country, mode } = input;

  if (typeof url !== "string" || url.length === 0) {
    throw new RegionFetchValidationError("url must be a non-empty string.", "url");
  }
  if (url.length > REGION_FETCH_MAX_URL_LENGTH) {
    throw new RegionFetchValidationError(
      `url must be at most ${REGION_FETCH_MAX_URL_LENGTH} characters (got ${url.length}).`,
      "url",
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RegionFetchValidationError(`url is not a valid URL: ${JSON.stringify(url)}`, "url");
  }
  if (parsed.protocol !== "https:") {
    throw new RegionFetchValidationError(
      `url must use https (got ${parsed.protocol}). The API only retrieves public HTTPS URLs.`,
      "url",
    );
  }
  if (looksPrivate(parsed.hostname)) {
    throw new RegionFetchValidationError(
      `url targets a private or loopback host (${parsed.hostname}), which the API rejects.`,
      "url",
    );
  }

  if (!REGION_FETCH_COUNTRIES.includes(country as RegionFetchCountry)) {
    throw new RegionFetchValidationError(
      `country must be one of ${REGION_FETCH_COUNTRIES.join(", ")} (got ${JSON.stringify(country)}).`,
      "country",
    );
  }

  if (mode !== undefined && !REGION_FETCH_MODES.includes(mode as RegionFetchMode)) {
    throw new RegionFetchValidationError(
      `mode must be one of ${REGION_FETCH_MODES.join(", ")} (got ${JSON.stringify(mode)}).`,
      "mode",
    );
  }

  return mode === undefined
    ? { url, country: country as RegionFetchCountry }
    : { url, country: country as RegionFetchCountry, mode: mode as RegionFetchMode };
}

/** Request IDs are `gf_` followed by 32 lowercase hex characters. */
export function validateRequestId(requestId: string): string {
  if (typeof requestId !== "string" || !/^gf_[0-9a-f]{32}$/.test(requestId)) {
    throw new RegionFetchValidationError(
      `requestId must match gf_<32 hex characters> (got ${JSON.stringify(requestId)}).`,
      "requestId",
    );
  }
  return requestId;
}
