/**
 * Header and value redaction.
 *
 * A payment signature is a bearer authorization. Anything that escapes into a
 * log, an error message, or MCP output is spendable by whoever reads it, so
 * redaction runs on every diagnostic path rather than being opt-in.
 */

const REDACTED = "[redacted]";

/** Header names never emitted in diagnostics, in lowercase. */
export const SENSITIVE_HEADERS: readonly string[] = [
  "payment-signature",
  "x-payment",
  "payment-response",
  "x-payment-response",
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
];

export function isSensitiveHeader(name: string): boolean {
  return SENSITIVE_HEADERS.includes(name.toLowerCase());
}

/** Copy headers with every sensitive value replaced. Safe to log. */
export function redactHeaders(headers: Headers | Record<string, string>): Record<string, string> {
  const entries =
    headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    out[name] = isSensitiveHeader(name) ? REDACTED : value;
  }
  return out;
}

/**
 * Strip anything that looks like a secret out of free text.
 *
 * Deliberately blunt: it is better to over-redact a diagnostic string than to
 * let one payment payload reach a transcript.
 */
export function redactText(text: string): string {
  return text
    .replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, REDACTED)
    .replace(
      /((?:payment[-_]?signature|x-payment|private[-_]?key|secret|token)["'\s:=]+)[^\s"',}]{16,}/gi,
      `$1${REDACTED}`,
    );
}
