import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RegionFetchClient,
  redactText,
  type RegionFetchAttestationKey,
  type RegionFetchInput,
  type RegionFetchPaymentProvider,
} from "regionfetch";
import { createX402PaymentProvider } from "regionfetch/x402";

import type { RegionFetchMcpConfig } from "./config.js";
import {
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_TITLE,
  runRegionFetchTool,
  toolInputSchema,
  toolOutputSchema,
  type ToolDependencies,
} from "./tools/regionfetch.js";

export const SERVER_NAME = "regionfetch-mcp";
export const SERVER_VERSION = "0.1.0";

/** How long a fetched attestation key is trusted before revalidating. Keys rotate. */
const KEY_CACHE_TTL_MS = 10 * 60 * 1000;

/** Everything written to stderr passes through here. stdout is JSON-RPC only. */
export type Logger = (message: string) => void;

export const stderrLogger: Logger = (message) => {
  process.stderr.write(`${redactText(message)}\n`);
};

export interface BuildServerOptions {
  config: RegionFetchMcpConfig;
  /** Injectable for tests. */
  client?: RegionFetchClient;
  log?: Logger;
}

async function buildPaymentProvider(
  config: RegionFetchMcpConfig,
): Promise<RegionFetchPaymentProvider | undefined> {
  if (config.paymentMode !== "wallet" || config.walletPrivateKey === undefined) {
    return undefined;
  }
  return createX402PaymentProvider({
    privateKey: config.walletPrivateKey,
    maxAmountPerPayment: config.maxAmountPerPayment,
    ...(config.rpcUrl === undefined ? {} : { rpcUrl: config.rpcUrl }),
  });
}

/** Memoize the deployment key, re-fetching after the TTL so rotation is picked up. */
function createKeyResolver(
  client: RegionFetchClient,
  log: Logger,
): () => Promise<RegionFetchAttestationKey | undefined> {
  let cached: { key: RegionFetchAttestationKey; fetchedAt: number } | undefined;

  return async () => {
    if (cached && Date.now() - cached.fetchedAt < KEY_CACHE_TTL_MS) return cached.key;
    try {
      const key = await client.getAttestationKey();
      cached = { key, fetchedAt: Date.now() };
      return key;
    } catch (error) {
      log(
        `Could not retrieve the deployment attestation key; receipts will be verified against their embedded key only: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return cached?.key;
    }
  };
}

export async function buildServer(options: BuildServerOptions): Promise<McpServer> {
  const { config } = options;
  const log = options.log ?? stderrLogger;

  const paymentProvider = await buildPaymentProvider(config);

  const client =
    options.client ??
    new RegionFetchClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
      allowInsecureHttpForDevelopment: config.allowInsecureHttpForDevelopment,
      userAgent: `${SERVER_NAME}/${SERVER_VERSION}`,
      ...(paymentProvider === undefined ? {} : { paymentProvider }),
    });

  const deps: ToolDependencies = {
    client,
    ...(config.paymentMode === "static-signature"
      ? { paymentSignature: config.paymentSignature }
      : {}),
    getAttestationKey: createKeyResolver(client, log),
  };

  // Only `tools` is advertised. The server implements no resources, prompts, or
  // subscriptions, and must not claim capabilities it does not serve.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    TOOL_NAME,
    {
      title: TOOL_TITLE,
      description: TOOL_DESCRIPTION,
      inputSchema: toolInputSchema,
      outputSchema: toolOutputSchema,
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
        idempotentHint: false,
      },
    },
    async (args) => {
      const envelope = await runRegionFetchTool(args as RegionFetchInput, deps);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope as unknown as Record<string, unknown>,
        isError: !envelope.ok,
      };
    },
  );

  return server;
}
