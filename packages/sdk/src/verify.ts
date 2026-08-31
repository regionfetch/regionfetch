/**
 * Receipt verification.
 *
 * Node-only: uses `node:crypto` for Ed25519. Verification is deliberately
 * layered — a valid signature only proves the holder of *some* key signed
 * *some* bytes, so this module also checks that the key is really Ed25519, that
 * the signed bytes parse to the payload that was handed to you, that the
 * receipt's convenience fields agree with the signed payload, and optionally
 * that the body you received hashes to what was attested.
 */
import { createHash, createPublicKey, verify as nodeVerify } from "node:crypto";

import type {
  RegionFetchAttestationPayload,
  RegionFetchReceipt,
} from "./types.js";

export interface RegionFetchVerifyOptions {
  /** Require the receipt's attestation key id to equal this value. */
  expectedKeyId?: string;
  /** Require the receipt's attestation key to equal this PEM. */
  expectedPublicKeyPem?: string;
  /** The response body, to check against the attested `contentSha256`. */
  responseBody?: string;
}

export interface RegionFetchVerificationResult {
  /** True only when every check that ran passed. */
  valid: boolean;
  /** Ed25519 signature over the exact bytes of `payloadCanonical`. */
  signatureValid: boolean;
  /** `payloadCanonical` parses to a value deep-equal to `attestation.payload`. */
  payloadMatches: boolean;
  /** Receipt-level convenience fields agree with the signed payload. */
  receiptFieldsMatch: boolean;
  /** Present only when `responseBody` was supplied. */
  bodyHashMatches?: boolean;
  /** Present only when a key expectation was supplied. */
  keyMatchesExpectation?: boolean;
  /** Human-readable reasons for every failed check. */
  errors: string[];
}

const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
const ED25519_SIGNATURE_BYTES = 64;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const aKeys = Object.keys(a as object).sort();
  const bKeys = Object.keys(b as object).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (!aKeys.every((key, index) => key === bKeys[index])) return false;
  return aKeys.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** Lowercase hex SHA-256 over the UTF-8 bytes of `body`. */
export function sha256Hex(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function decodeSignature(signature: string): Buffer | null {
  if (typeof signature !== "string" || !BASE64URL_RE.test(signature)) return null;
  const decoded = Buffer.from(signature, "base64url");
  return decoded.length === ED25519_SIGNATURE_BYTES ? decoded : null;
}

/**
 * Fields duplicated between the receipt root and the signed payload. Anything
 * listed here must agree, or a caller reading the convenience field would see
 * something the deployment never signed.
 */
const MIRRORED_FIELDS = [
  "requestId",
  "supplier",
  "country",
  "mode",
  "status",
  "statusCode",
  "finalUrl",
  "bytesTransferred",
  "contentSha256",
  "completedAt",
] as const satisfies readonly (keyof RegionFetchReceipt & keyof RegionFetchAttestationPayload)[];

/**
 * Verify a Region Fetch receipt.
 *
 * Never throws for an invalid receipt — a malformed or forged receipt comes
 * back as `valid: false` with reasons, so callers can log the failure alongside
 * the payment rather than losing it to an exception.
 */
export function verifyReceipt(
  receipt: RegionFetchReceipt,
  options: RegionFetchVerifyOptions = {},
): RegionFetchVerificationResult {
  const errors: string[] = [];
  let signatureValid = false;
  let payloadMatches = false;
  let receiptFieldsMatch = false;
  let bodyHashMatches: boolean | undefined;
  let keyMatchesExpectation: boolean | undefined;

  const attestation = receipt?.attestation;
  if (!attestation || typeof attestation !== "object") {
    return {
      valid: false,
      signatureValid: false,
      payloadMatches: false,
      receiptFieldsMatch: false,
      errors: ["Receipt has no attestation."],
    };
  }

  if (attestation.algorithm !== "Ed25519") {
    errors.push(`Unsupported attestation algorithm: ${String(attestation.algorithm)}.`);
  }

  // Signature.
  const signatureBytes = decodeSignature(attestation.signature);
  if (!signatureBytes) {
    errors.push("Signature is not a base64url-encoded 64-byte Ed25519 signature.");
  } else if (typeof attestation.payloadCanonical !== "string") {
    errors.push("payloadCanonical is missing or not a string.");
  } else {
    try {
      const publicKey = createPublicKey(attestation.publicKeyPem);
      // The declared algorithm is attacker-controlled text. Check the real key
      // type so an RSA or EC key cannot be substituted under an "Ed25519" label.
      if (publicKey.asymmetricKeyType !== "ed25519") {
        errors.push(
          `Attestation key is ${String(publicKey.asymmetricKeyType)}, not ed25519.`,
        );
      } else {
        signatureValid = nodeVerify(
          null,
          Buffer.from(attestation.payloadCanonical, "utf8"),
          publicKey,
          signatureBytes,
        );
        if (!signatureValid) errors.push("Ed25519 signature did not verify.");
      }
    } catch (cause) {
      errors.push(
        `Could not read attestation public key: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  // The signed bytes must describe the payload the caller was handed.
  let parsedCanonical: unknown;
  if (typeof attestation.payloadCanonical === "string") {
    try {
      parsedCanonical = JSON.parse(attestation.payloadCanonical);
      payloadMatches = deepEqual(parsedCanonical, attestation.payload);
      if (!payloadMatches) {
        errors.push("attestation.payload does not match the signed payloadCanonical bytes.");
      }
    } catch {
      errors.push("payloadCanonical is not valid JSON.");
    }
  }

  // Receipt-level duplicates must agree with the signed payload.
  const payload = attestation.payload;
  if (payload && typeof payload === "object") {
    const mismatched = MIRRORED_FIELDS.filter(
      (field) =>
        receipt[field] !== undefined && !deepEqual(receipt[field], payload[field]),
    );
    receiptFieldsMatch = mismatched.length === 0;
    for (const field of mismatched) {
      errors.push(
        `Receipt field ${field} (${JSON.stringify(receipt[field])}) does not match the signed payload (${JSON.stringify(payload[field])}).`,
      );
    }
    if (payload.version !== "1") {
      errors.push(`Unsupported attestation payload version: ${String(payload.version)}.`);
    }
  } else {
    errors.push("attestation.payload is missing.");
  }

  // Optional: does the body we hold hash to what was attested?
  if (options.responseBody !== undefined) {
    const attested = payload?.contentSha256;
    if (typeof attested !== "string") {
      bodyHashMatches = false;
      errors.push("Receipt has no contentSha256 to compare the response body against.");
    } else {
      const actual = sha256Hex(options.responseBody);
      bodyHashMatches = actual === attested.toLowerCase();
      if (!bodyHashMatches) {
        errors.push(`Response body hash ${actual} does not match attested ${attested}.`);
      }
    }
  }

  // Optional: is this the key we expected, rather than merely a self-consistent one?
  if (options.expectedKeyId !== undefined || options.expectedPublicKeyPem !== undefined) {
    const idOk =
      options.expectedKeyId === undefined || options.expectedKeyId === attestation.keyId;
    const pemOk =
      options.expectedPublicKeyPem === undefined ||
      normalizePem(options.expectedPublicKeyPem) === normalizePem(attestation.publicKeyPem);
    keyMatchesExpectation = idOk && pemOk;
    if (!idOk) {
      errors.push(
        `Attestation key id ${attestation.keyId} does not match expected ${options.expectedKeyId}.`,
      );
    }
    if (!pemOk) errors.push("Attestation public key does not match the expected key.");
  }

  const valid =
    errors.length === 0 &&
    signatureValid &&
    payloadMatches &&
    receiptFieldsMatch &&
    bodyHashMatches !== false &&
    keyMatchesExpectation !== false;

  return {
    valid,
    signatureValid,
    payloadMatches,
    receiptFieldsMatch,
    ...(bodyHashMatches === undefined ? {} : { bodyHashMatches }),
    ...(keyMatchesExpectation === undefined ? {} : { keyMatchesExpectation }),
    errors,
  };
}

/** Compare PEMs by their base64 body, ignoring line endings and trailing space. */
function normalizePem(pem: string): string {
  return pem.replace(/\s+/g, "");
}
