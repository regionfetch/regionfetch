import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RegionFetchConfigError, RegionFetchValidationError } from "../src/errors.js";
import { normalizeBaseUrl, validateInput, validateRequestId } from "../src/validate.js";

describe("normalizeBaseUrl", () => {
  it("strips a trailing slash and a trailing /api", () => {
    assert.equal(normalizeBaseUrl("https://regionfetch.dev"), "https://regionfetch.dev");
    assert.equal(normalizeBaseUrl("https://regionfetch.dev/"), "https://regionfetch.dev");
    assert.equal(normalizeBaseUrl("https://regionfetch.dev/api"), "https://regionfetch.dev");
    assert.equal(normalizeBaseUrl("https://regionfetch.dev/api/"), "https://regionfetch.dev");
  });

  it("preserves a path prefix that is not /api", () => {
    assert.equal(
      normalizeBaseUrl("https://gateway.test/regionfetch"),
      "https://gateway.test/regionfetch",
    );
  });

  it("rejects http unless development is opted into", () => {
    assert.throws(() => normalizeBaseUrl("http://localhost:3000"), RegionFetchConfigError);
    assert.equal(
      normalizeBaseUrl("http://localhost:3000", { allowInsecureHttpForDevelopment: true }),
      "http://localhost:3000",
    );
  });

  it("rejects embedded credentials and unparseable values", () => {
    assert.throws(() => normalizeBaseUrl("https://user:pw@regionfetch.dev"), RegionFetchConfigError);
    assert.throws(() => normalizeBaseUrl("not a url"), RegionFetchConfigError);
  });
});

describe("validateInput", () => {
  const valid = { url: "https://example.com/", country: "US" as const };

  it("accepts every supported country and mode", () => {
    for (const country of ["US", "DE", "JP", "BR", "IN"] as const) {
      for (const mode of ["http", "browser"] as const) {
        assert.deepEqual(validateInput({ ...valid, country, mode }), {
          url: valid.url,
          country,
          mode,
        });
      }
    }
  });

  it("omits mode when it was not supplied, rather than defaulting locally", () => {
    assert.deepEqual(validateInput(valid), { url: valid.url, country: "US" });
  });

  it("rejects unknown fields, because the API rejects them too", () => {
    assert.throws(
      () => validateInput({ ...valid, fresh: true } as never),
      (error: unknown) =>
        error instanceof RegionFetchValidationError && error.field === "fresh",
    );
  });

  it("rejects an unsupported country", () => {
    assert.throws(
      () => validateInput({ ...valid, country: "ZZ" as never }),
      (error: unknown) =>
        error instanceof RegionFetchValidationError && error.field === "country",
    );
  });

  it("rejects an unsupported mode", () => {
    assert.throws(
      () => validateInput({ ...valid, mode: "headless" as never }),
      (error: unknown) => error instanceof RegionFetchValidationError && error.field === "mode",
    );
  });

  it("rejects non-https URLs", () => {
    assert.throws(
      () => validateInput({ ...valid, url: "http://example.com/" }),
      RegionFetchValidationError,
    );
    assert.throws(
      () => validateInput({ ...valid, url: "file:///etc/passwd" }),
      RegionFetchValidationError,
    );
  });

  it("rejects URLs over the 2048-character server limit", () => {
    const long = `https://example.com/${"a".repeat(2049)}`;
    assert.throws(() => validateInput({ ...valid, url: long }), RegionFetchValidationError);
  });

  it("rejects loopback and private targets before a payment is created", () => {
    for (const host of [
      "https://localhost/",
      "https://127.0.0.1/",
      "https://10.1.2.3/",
      "https://192.168.0.1/",
      "https://169.254.169.254/",
      "https://172.16.0.1/",
      "https://[::1]/",
    ]) {
      assert.throws(
        () => validateInput({ ...valid, url: host }),
        RegionFetchValidationError,
        `expected ${host} to be rejected`,
      );
    }
  });
});

describe("validateRequestId", () => {
  it("accepts the gf_ + 32 hex form", () => {
    const id = "gf_0123456789abcdef0123456789abcdef";
    assert.equal(validateRequestId(id), id);
  });

  it("rejects anything else", () => {
    for (const bad of ["nope", "gf_short", "gf_0123456789ABCDEF0123456789abcdef", ""]) {
      assert.throws(() => validateRequestId(bad), RegionFetchValidationError);
    }
  });
});
