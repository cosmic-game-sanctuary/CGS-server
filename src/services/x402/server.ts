import { x402ResourceServer, HTTPFacilitatorClient } from "@x402/core/server";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { env } from "../../config/env.js";

// Blocky402 is the facilitator the Hedera bounty requires. It verifies the
// payment, adds its own fee-payer signature, pays the network fee, and submits.
// We never hold the buyer's funds or run a node.
const facilitator = new HTTPFacilitatorClient({ url: env.X402_FACILITATOR_URL });

export const resourceServer = new x402ResourceServer(facilitator).register(
  env.X402_NETWORK,
  new ExactHederaScheme({
    defaultAssets: {
      [env.X402_NETWORK]: { asset: env.X402_ASSET, decimals: env.X402_ASSET_DECIMALS },
    },
  }),
);

// the facilitator's supported kinds (including its feePayer account) are
// fetched once and cached on the server instance — without this, the first
// 402 wouldn't know which account will sponsor the fee.
let initialized: Promise<void> | undefined;
export function ensureInitialized() {
  initialized ??= resourceServer.initialize();
  return initialized;
}

// x402 sends the payload as base64-encoded JSON. Newer clients use
// `payment-signature`; `x-payment` is the older header the spec started with,
// and standard clients still send it — accept both.
export function readPaymentHeader(headers: Record<string, unknown>): string | undefined {
  const value = headers["payment-signature"] ?? headers["x-payment"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function decodePaymentPayload(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}
