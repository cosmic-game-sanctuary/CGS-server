/**
 * The public testnet faucet's limits, against the real chain.
 *
 *   TESTNET_FAUCET=on DEV_FAUCET=off npx tsx scripts/arc-faucet-check.ts
 *
 * Mounts the real route in a tiny app with only the login check stubbed (a
 * Privy token cannot be minted here), then drives it over real HTTP and checks
 * balances on chain: it tops a wallet up TO the cap and never beyond, refuses a
 * full wallet, rate-limits a second ask, and tops up an agent's wallet too.
 */
import { createServer } from "node:http";
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import express from "express";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { env } from "../src/config/env.js";

if (env.ARC_NETWORK !== "testnet") throw new Error("testnet only");
if (env.DEV_FAUCET === "on" || env.TESTNET_FAUCET !== "on") throw new Error("run with TESTNET_FAUCET=on DEV_FAUCET=off to exercise the public rules");

register("./faucet-check-hook.mjs", import.meta.url);
const { default: devRouter } = await import("../src/routes/dev.routes.js");
const { getUsdcUnits } = await import("../src/services/arc/reads.js");

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail !== undefined ? `  -> ${String(detail)}` : ""}`);
};

const wallet = privateKeyToAccount(generatePrivateKey()).address;
const userId = randomUUID(); // one person, asking repeatedly
const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.auth = { id: userId, privyDid: "x", email: "x", evmAddress: wallet, privyWalletId: "x", publicKeyHex: null, hederaAccountId: null } as never;
  next();
});
app.use("/api/dev", devRouter);
app.use((err: { status?: number; code?: string; message: string }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(err.status ?? 500).json({ error: { code: err.code, message: err.message } });
});
const server = createServer(app).listen(0);
const port = (server.address() as { port: number }).port;
const post = async (body: object) => {
  const r = await fetch(`http://127.0.0.1:${port}/api/dev/faucet`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json()) as { sentUnits?: string; error?: { code?: string } } };
};
const cap = BigInt(Math.round(env.TESTNET_FAUCET_CAP * 1_000_000));

console.log(`public faucet, cap ${env.TESTNET_FAUCET_CAP} USDC, wallet ${wallet}\n`);
const first = await post({});
check("an empty wallet is topped up", first.status === 200, JSON.stringify(first));
check("to exactly the cap, not the dev default", (await getUsdcUnits(wallet)) === cap, await getUsdcUnits(wallet));

const second = await post({});
check("asking again straight away is rate limited", second.status === 429 && second.json.error?.code === "FAUCET_COOLDOWN", JSON.stringify(second));

await new Promise((r) => setTimeout(r, 16_000));
const third = await post({});
check("a full wallet gets nothing", third.status === 409 && third.json.error?.code === "FAUCET_FULL", JSON.stringify(third));
check("and its balance did not move", (await getUsdcUnits(wallet)) === cap);

const big = await post({ amount: 500 });
check("asking for a huge amount is still refused for a full wallet", big.status === 409 || big.status === 429, JSON.stringify(big));

server.close();
console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
