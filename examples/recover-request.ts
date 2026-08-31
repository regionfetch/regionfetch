/**
 * Recovery after an ambiguous failure.
 *
 * If the connection drops after you sent a payment, do NOT create a second
 * payment. Either resend the identical body with the identical authorization,
 * or — if you captured a request id — look the request up.
 *
 *   npx tsx examples/recover-request.ts gf_0123456789abcdef0123456789abcdef
 */
import { RegionFetchClient } from "regionfetch";

const requestId = process.argv[2];
if (!requestId) throw new Error("Usage: recover-request.ts <requestId>");

const client = new RegionFetchClient();
const state = await client.getRequest(requestId);

switch (state.status) {
  case "succeeded":
    console.log("terminal success,", state.receipt.bytesTransferred, "bytes");
    break;
  case "failed":
    // A stored terminal failure comes back as HTTP 200. The detail lives in the
    // signed receipt, not in an error envelope.
    console.log("terminal failure, status", state.receipt.statusCode);
    break;
  case "settling":
  case "executing":
    console.log("still in flight:", state.message);
    break;
  case "unresolved":
    // Execution may have happened but was never persisted. The server will not
    // re-run it, because that could duplicate an external effect after payment.
    console.error("unresolved — reconcile against the settlement transaction.");
    process.exitCode = 1;
    break;
}
