import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

const SERVER_ENTRY = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
const WALLET_KEY = `0x${"a".repeat(64)}`;
const SIGNATURE = "a-real-looking-payment-authorization-value";

interface RunResult {
  stdout: string;
  stderr: string;
}

/** Drive the built server over real stdio with a single initialize request. */
function runServer(env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settleTimer: NodeJS.Timeout | undefined;

    // Resolve shortly after the first complete JSON-RPC line rather than waiting
    // out the whole timeout — the server stays connected by design.
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("\n") && settleTimer === undefined) {
        settleTimer = setTimeout(() => {
          child.kill();
        }, 150);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);

    const request = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "stdio-test", version: "1.0.0" },
      },
    };
    child.stdin.write(`${JSON.stringify(request)}\n`);

    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout, stderr });
    }, 8000);

    child.on("close", () => {
      clearTimeout(timer);
      if (settleTimer !== undefined) clearTimeout(settleTimer);
      resolve({ stdout, stderr });
    });
  });
}

describe("stdio hygiene", () => {
  it("writes only JSON-RPC to stdout and diagnostics to stderr", async () => {
    const { stdout, stderr } = await runServer({
      REGION_FETCH_PAYMENT_SIGNATURE: SIGNATURE,
    });

    const lines = stdout.split("\n").filter((line) => line.trim() !== "");
    assert.ok(lines.length > 0, "the server must answer initialize on stdout");
    for (const line of lines) {
      const message = JSON.parse(line) as { jsonrpc?: string };
      assert.equal(message.jsonrpc, "2.0", `stdout carried non-JSON-RPC: ${line}`);
    }
    assert.ok(stderr.includes("Region Fetch MCP server"), "the startup banner belongs on stderr");
  });

  it("keeps the payment signature out of both streams", async () => {
    const { stdout, stderr } = await runServer({ REGION_FETCH_PAYMENT_SIGNATURE: SIGNATURE });
    assert.ok(!stdout.includes(SIGNATURE));
    assert.ok(!stderr.includes(SIGNATURE));
  });

  it("keeps the wallet key out of both streams", async () => {
    const { stdout, stderr } = await runServer({ REGION_FETCH_WALLET_PRIVATE_KEY: WALLET_KEY });
    assert.ok(!stdout.includes(WALLET_KEY));
    assert.ok(!stderr.includes(WALLET_KEY));
    assert.ok(stderr.includes("wallet"), "the mode itself is safe to report");
  });

  it("says plainly when no payment is configured", async () => {
    const { stderr } = await runServer({
      REGION_FETCH_PAYMENT_SIGNATURE: "",
      REGION_FETCH_WALLET_PRIVATE_KEY: "",
      PAYMENT_SIGNATURE: "",
      GEOFETCH_PAYMENT_SIGNATURE: "",
    });
    assert.ok(stderr.includes("No payment configured"));
  });
});
