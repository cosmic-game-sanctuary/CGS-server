import { PrivyClient } from "@privy-io/node";
import { env } from "../../config/env.js";

// one client for the whole process — auth verification, wallet creation for
// agents, and (later) the secp256k1 signing bridge all go through this.
export const privy = new PrivyClient({
  appId: env.PRIVY_APP_ID,
  appSecret: env.PRIVY_APP_SECRET,
});
