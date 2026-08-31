import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RegionFetchClient } from "regionfetch";

import { loadConfig } from "../src/config.js";
import { buildServer } from "../src/server.js";

const keyPair = generateKeyPairSync("ed25519");
const PUBLIC_KEY_PEM = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
const KEY_ID = "0123456789abcdef";
const BODY = "<!doctype html><title>hello</title>";
const REQUEST_ID = "gf_0123456789abcdef0123456789abcdef";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function makeReceipt(overrides: Record<string, unknown> = {}): unknown {
  const payload = {
    version: "1",
    requestId: REQUEST_ID,
    paymentId: "eip155:8453:abc",
    targetUrl: "https://example.com/",
    finalUrl: "https://example.com/",
    country: "US",
    mode: "http",
    supplier: "test-supplier",
    status: "succeeded",
    statusCode: 200,
    bytesTransferred: BODY.length,
    contentSha256: sha256Hex(BODY),
    completedAt: "2026-08-30T18:00:00.000Z",
    ...overrides,
  };
  const payloadCanonical = JSON.stringify(payload);
  return {
    requestId: payload.requestId,
    supplier: payload.supplier,
    country: payload.country,
    mode: payload.mode,
    status: payload.status,
    statusCode: payload.statusCode,
    finalUrl: payload.finalUrl,
    bytesTransferred: payload.bytesTransferred,
    contentSha256: payload.contentSha256,
    completedAt: payload.completedAt,
    attestation: {
      algorithm: "Ed25519",
      keyId: KEY_ID,
      publicKeyPem: PUBLIC_KEY_PEM,
      payload,
      payloadCanonical,
      signature: sign(null, Buffer.from(payloadCanonical, "utf8"), keyPair.privateKey).toString(
        "base64url",
      ),
    },
  };
}

interface Scripted {
  status: number;
  body: unknown;
}

function stubClient(script: Scripted[]): RegionFetchClient {
  let index = 0;
  const fetchImpl = (async (input: unknown) => {
    const url = new Request(input as string).url;
    if (url.endsWith("/api/attestation-key")) {
      return new Response(
        JSON.stringify({ algorithm: "Ed25519", keyId: KEY_ID, publicKeyPem: PUBLIC_KEY_PEM }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const spec = script[Math.min(index, script.length - 1)]!;
    index += 1;
    return new Response(JSON.stringify(spec.body), {
      status: spec.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;

  return new RegionFetchClient({ fetch: fetchImpl });
}

async function connect(script: Scripted[]): Promise<Client> {
  const server = await buildServer({
    config: loadConfig({ REGION_FETCH_PAYMENT_SIGNATURE: "test-authorization" }),
    client: stubClient(script),
    log: () => {},
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-harness", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const SUCCESS: Scripted = {
  status: 200,
  body: {
    data: { url: "https://example.com/", contentType: "text/html", body: BODY },
    receipt: makeReceipt(),
  },
};

describe("MCP protocol", () => {
  it("advertises only the tools capability", async () => {
    const client = await connect([SUCCESS]);
    const capabilities = client.getServerCapabilities();
    assert.ok(capabilities?.tools);
    assert.equal(capabilities?.resources, undefined);
    assert.equal(capabilities?.prompts, undefined);
    await client.close();
  });

  it("lists the regionfetch tool with the v1 input schema", async () => {
    const client = await connect([SUCCESS]);
    const { tools } = await client.listTools();

    assert.equal(tools.length, 1);
    const tool = tools[0]!;
    assert.equal(tool.name, "regionfetch");
    assert.equal(tool.title, "Region Fetch");
    assert.ok(tool.description?.includes("country"));

    const schema = tool.inputSchema as unknown as Record<string, unknown>;
    assert.equal(schema["type"], "object");
    assert.deepEqual(schema["required"], ["url", "country"]);
    assert.equal(schema["additionalProperties"], false);

    const properties = schema["properties"] as unknown as Record<string, Record<string, unknown>>;
    assert.equal(properties["url"]?.["maxLength"], 2048);
    assert.deepEqual(properties["country"]?.["enum"], ["US", "DE", "JP", "BR", "IN"]);
    assert.deepEqual(properties["mode"]?.["enum"], ["http", "browser"]);
    await client.close();
  });

  it("returns text plus structuredContent on success", async () => {
    const client = await connect([SUCCESS]);
    const result = await client.callTool({
      name: "regionfetch",
      arguments: { url: "https://example.com/", country: "US" },
    });

    assert.equal(result.isError, false);
    const structured = result.structuredContent as Record<string, unknown>;
    assert.equal(structured["status"], 200);
    assert.equal(structured["ok"], true);

    const content = result.content as { type: string; text: string }[];
    assert.equal(content[0]?.type, "text");
    assert.deepEqual(JSON.parse(content[0]!.text), structured);
    await client.close();
  });

  it("verifies the receipt against the deployment's published key", async () => {
    const client = await connect([SUCCESS]);
    const result = await client.callTool({
      name: "regionfetch",
      arguments: { url: "https://example.com/", country: "US" },
    });

    const verification = (result.structuredContent as Record<string, Record<string, unknown>>)[
      "verification"
    ]!;
    assert.equal(verification["valid"], true);
    assert.equal(verification["signatureValid"], true);
    assert.equal(verification["bodyHashMatches"], true);
    assert.equal(verification["keyMatchesExpectation"], true);
    assert.equal(verification["checkedAgainstDeploymentKey"], true);
    await client.close();
  });

  it("preserves an upstream failure body and its signed receipt", async () => {
    const receipt = makeReceipt({ status: "failed", statusCode: 403, contentSha256: null });
    const client = await connect([
      {
        status: 502,
        body: {
          error: { code: "http_status_403", message: "The geo-targeted supplier fetch failed." },
          receipt,
        },
      },
    ]);

    const result = await client.callTool({
      name: "regionfetch",
      arguments: { url: "https://example.com/", country: "DE" },
    });

    assert.equal(result.isError, true);
    const structured = result.structuredContent as unknown as Record<string, unknown>;
    assert.equal(structured["status"], 502);
    assert.equal(structured["ok"], false);

    const response = structured["response"] as unknown as Record<string, Record<string, string>>;
    assert.equal(response["error"]?.["code"], "http_status_403");
    assert.ok(response["receipt"], "the signed terminal receipt must survive");
    await client.close();
  });

  it("rejects invalid arguments without contacting the API", async () => {
    const client = await connect([SUCCESS]);
    const result = await client.callTool({
      name: "regionfetch",
      arguments: { url: "https://example.com/", country: "ZZ" },
    });
    assert.equal(result.isError, true);
    await client.close();
  });

  it("rejects a non-https URL at the schema boundary", async () => {
    const client = await connect([SUCCESS]);
    const result = await client.callTool({
      name: "regionfetch",
      arguments: { url: "http://example.com/", country: "US" },
    });
    assert.equal(result.isError, true);
    await client.close();
  });

  it("errors on an unknown tool", async () => {
    // Optional future tools are not part of the v1 contract and must not
    // silently resolve to the regionfetch handler.
    const client = await connect([SUCCESS]);
    const result = await client.callTool({ name: "regionfetch_status", arguments: {} });
    assert.equal(result.isError, true);
    await client.close();
  });

  it("never echoes the payment signature into tool output", async () => {
    const client = await connect([SUCCESS]);
    const result = await client.callTool({
      name: "regionfetch",
      arguments: { url: "https://example.com/", country: "US" },
    });
    assert.ok(!JSON.stringify(result).includes("test-authorization"));
    await client.close();
  });
});
