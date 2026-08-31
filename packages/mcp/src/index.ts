#!/usr/bin/env node
/**
 * Region Fetch MCP server (stdio).
 *
 * stdout carries JSON-RPC and nothing else. Every diagnostic goes to stderr,
 * through a redacting logger, so a payment authorization or wallet key can
 * never reach a transcript.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { describeConfig, loadConfig } from "./config.js";
import { buildServer, stderrLogger } from "./server.js";

export { buildServer, SERVER_NAME, SERVER_VERSION, type Logger } from "./server.js";
export { loadConfig, describeConfig, type RegionFetchMcpConfig } from "./config.js";
export {
  TOOL_DESCRIPTION,
  TOOL_NAME,
  TOOL_TITLE,
  runRegionFetchTool,
  type RegionFetchToolEnvelope,
} from "./tools/regionfetch.js";

async function main(): Promise<void> {
  const config = loadConfig();
  for (const line of describeConfig(config)) stderrLogger(line);

  const server = await buildServer({ config });
  await server.connect(new StdioServerTransport());
}

// Only run when executed directly, so the module stays importable by tests.
const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  main().catch((error: unknown) => {
    stderrLogger(
      `Region Fetch MCP server failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  });
}
