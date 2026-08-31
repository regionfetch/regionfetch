# regionfetch-mcp

MCP server for [Region Fetch](https://regionfetch.dev) — fetch a public HTTPS
URL as a visitor in a specific country would see it, with a signed Ed25519
receipt proving where the retrieval came from.

> **Pre-release.** Not yet published to npm. Build from source:
> <https://github.com/regionfetch/regionfetch>

```bash
npx -y regionfetch-mcp
```

Node 20.11+. stdio transport. Exposes exactly one tool: `regionfetch`.

## Configuration

### Wallet mode (recommended)

```json
{
  "mcpServers": {
    "regionfetch": {
      "command": "npx",
      "args": ["-y", "regionfetch-mcp"],
      "env": {
        "REGION_FETCH_BASE_URL": "https://regionfetch.dev",
        "REGION_FETCH_WALLET_PRIVATE_KEY": "0x...",
        "REGION_FETCH_MAX_PAYMENT": "$0.10"
      }
    }
  }
}
```

The server signs one fresh x402 authorization per tool call. This is the only
configuration that keeps working past the first request.

### Static signature (testing only)

```json
"env": { "REGION_FETCH_PAYMENT_SIGNATURE": "<one x402 authorization>" }
```

One authorization funds one request, so the **second** tool call will fail. The
server says so on stderr at startup. Useful for a one-shot compatibility check,
not for a running server.

Wallet mode wins when both are configured.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `REGION_FETCH_BASE_URL` | `https://regionfetch.dev` | Deployment origin. A trailing `/api` is stripped. |
| `REGION_FETCH_WALLET_PRIVATE_KEY` | — | Funded Base wallet key. Enables wallet mode. |
| `REGION_FETCH_MAX_PAYMENT` | `$0.10` | Per-payment ceiling. `off` disables it. |
| `REGION_FETCH_PAYMENT_SIGNATURE` | — | A single pre-made authorization. |
| `REGION_FETCH_RPC_URL` | — | RPC endpoint for on-chain reads during payment construction. |
| `REGION_FETCH_TIMEOUT_MS` | `120000` | Per-request timeout. |
| `REGION_FETCH_ALLOW_INSECURE_HTTP` | `0` | Permit an `http://` base URL. Development only. |

Legacy `GEOFETCH_BASE_URL`, `GEOFETCH_PAYMENT_SIGNATURE`, and `PAYMENT_SIGNATURE`
are still read, with the canonical names taking precedence. Their use is
reported as deprecated on stderr.

## The tool

**`regionfetch`** — `url` (https, ≤ 2048 chars), `country`
(`US` | `DE` | `JP` | `BR` | `IN`), `mode` (`http` | `browser`, default `http`).

Results use the v1 envelope:

```json
{
  "status": 200,
  "ok": true,
  "response": { "data": { "...": "..." }, "receipt": { "...": "..." } },
  "verification": { "valid": true, "signatureValid": true, "bodyHashMatches": true }
}
```

`verification` is an additive field: the server verifies each receipt against the
deployment's published key and the returned body before handing it to the model.
Consumers reading only `status`, `ok`, and `response` are unaffected.

Non-2xx responses keep the upstream status and JSON body verbatim and set
`isError: true`. Terminal paid failures (`502`, `504`) keep their signed
receipts — they are the evidence the paid attempt happened.

## Security

- Wallet keys and payment authorizations are never accepted as tool arguments,
  never written to stdout or stderr, and never returned in tool output.
- stdout carries JSON-RPC only; all diagnostics go to stderr through a redacting
  logger. Tests assert both.
- Only the `tools` capability is advertised. No resources, prompts, or
  subscriptions are implemented or claimed.

Full documentation: <https://github.com/regionfetch/regionfetch>

MIT
