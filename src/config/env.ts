import "dotenv/config";
import { createPublicKey } from "node:crypto";
import { z } from "zod";

// a real 0.0.x account id, not .env.example's `0.0.xxxxx` placeholder
const hederaAccountId = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a real Hedera account id like 0.0.12345");

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a real 0x address");

// Privy verifies access tokens against a P-256 public key, which `jose` loads
// with importSPKI — and that needs real PEM, armour and newlines included.
// A key pasted into a .env almost never arrives that way, and the failure is
// invisible until the first authenticated request, where it surfaces as
// `"spki" must be SPKI formatted string` on what looks like a login problem.
//
// So accept the three shapes it actually turns up in and normalise them here:
// proper PEM, PEM flattened onto one line with literal \n sequences (dotenv
// only expands those inside double quotes), and the bare base64 body the
// dashboard shows without any armour at all.
const privyVerificationKey = z
  .string()
  .min(1)
  .transform((raw, ctx) => {
    const text = raw.trim().replace(/\\n/g, "\n");
    if (text.includes("BEGIN PUBLIC KEY")) return text;

    const body = text.replace(/\s+/g, "");
    const pem = /^[A-Za-z0-9+/]+={0,2}$/.test(body)
      ? `-----BEGIN PUBLIC KEY-----\n${(body.match(/.{1,64}/g) ?? []).join("\n")}\n-----END PUBLIC KEY-----`
      : null;

    if (!pem) {
      ctx.addIssue({
        code: "custom",
        message:
          "must be the public key from the Privy dashboard, either full PEM " +
          "(-----BEGIN PUBLIC KEY-----…) or the bare base64 body.",
      });
      return z.NEVER;
    }
    return pem;
  })
  // Parsing it here turns a bad key into one clear line at boot instead of a
  // 401 on every authenticated request with `"spki" must be SPKI formatted
  // string` buried in it — which reads as a login bug rather than a config
  // one. No new dependency: node's own crypto rejects exactly what jose does.
  .refine(
    (pem) => {
      try {
        createPublicKey(pem);
        return true;
      } catch {
        return false;
      }
    },
    { message: "is not a valid public key. Re-copy it from the Privy dashboard." },
  );

// fails loudly at boot if something's missing, instead of an obscure crash
// three requests in.
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string(),
  DATABASE_URL_POOLED: z.string(),

  // `0.0.xxxxx` is what .env.example ships — catching it here turns a
  // confusing facilitator rejection into an obvious boot-time failure.
  HEDERA_OPERATOR_ID: hederaAccountId,
  HEDERA_OPERATOR_KEY: z.string(),
  HEDERA_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HEDERA_MIRROR_URL: z.string(),

  X402_FACILITATOR_URL: z.string(),
  // x402 types network as the CAIP-2 template literal `${string}:${string}`,
  // so a plain string doesn't satisfy it — validate the shape, then say so.
  X402_NETWORK: z
    .string()
    .regex(/^[^:]+:[^:]+$/, "must be CAIP-2, e.g. hedera:testnet")
    .default("hedera:testnet")
    .transform((v) => v as `${string}:${string}`),
  X402_ASSET: z.string(),
  X402_ASSET_DECIMALS: z.coerce.number(),
  // where buyers pay. A real 0.0.x, never an EVM address — facilitators
  // default to rejecting the alias auto-creation an address would trigger.
  X402_PAY_TO: hederaAccountId,

  HCS_LISTINGS_TOPIC: z.string().optional(),
  HCS_SALES_TOPIC: z.string().optional(),
  HCS_AGENT_IDENTITY_TOPIC: z.string().optional(),

  PRIVY_APP_ID: z.string(),
  PRIVY_APP_SECRET: z.string(),
  PRIVY_VERIFICATION_KEY: privyVerificationKey,

  PINATA_JWT: z.string(),
  // The account's dedicated gateway subdomain, e.g. "coral-imperial-alpaca-44
  // .mypinata.cloud". Find it under Gateways in the Pinata dashboard, or with
  // GET https://api.pinata.cloud/v3/ipfs/gateways.
  //
  // Strongly recommended, effectively required: without it everything falls
  // back to ipfs.io, which times out on freshly pinned content. That shows up
  // as broken cover art and a game that never boots — see services/ipfs/pinata.ts.
  PINATA_GATEWAY: z.string().optional(),

  // Email. Optional on purpose: without a key nothing is sent and every send
  // is logged instead, so a missing key degrades to silence rather than to a
  // crash on a path that is never the point of the request that triggered it.
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().default("CGS <onboarding@resend.dev>"),
  // Where a link in an email should point. Not the API's own origin: every
  // link we send is a page, and the person clicking it is in a browser.
  APP_URL: z.string().default("http://localhost:5173"),

  // no CSAM-scanning provider is wired yet (see docs/api-contract.md §6). This
  // fails closed on purpose — "skip" is a deliberate local escape hatch, not
  // a default, and it stays "block" until a real provider is chosen.
  CSAM_MODE: z.enum(["block", "skip"]).default("block"),

  AGENT_POLL_INTERVAL_MS: z.coerce.number().default(5000),

  // A dev-only route that funds a wallet from the operator account. It exists
  // because a Privy embedded wallet has no Hedera account until it first
  // receives value, and no public faucet hands out testnet USDC — so without
  // it a new test buyer can never buy anything. Off unless asked for, and
  // refused outright in production (see the refinement below).
  DEV_FAUCET: z.enum(["on", "off"]).default("off"),
  // Small on purpose. The operator's whole testnet USDC balance is what pays
  // every buyer AND every split, and the Circle faucet is the only way to
  // refill it — a generous default drains the treasury in four clicks. Games
  // cost a few dollars, so this covers a purchase either way.
  DEV_FAUCET_AMOUNT: z.coerce.number().positive().default(5),
  DEV_FAUCET_HBAR: z.coerce.number().positive().default(2),

  // ENSv2 beta, Sepolia-only. Every address here was checked against a
  // Sepolia RPC directly (real bytecode, sensible eth_call results) — the
  // canonical docs page and a pinned repo commit disagreed with each other,
  // so neither was trusted on its own. See docs/stage-7.md.
  SEPOLIA_RPC_URL: z.string(),
  SEPOLIA_OPERATOR_KEY: z.string().regex(/^0x[a-fA-F0-9]{64}$/, "must be a raw 32-byte private key"),
  ENS_ETH_REGISTRAR: evmAddress,
  ENS_VERIFIABLE_FACTORY: evmAddress,
  ENS_USER_REGISTRY_IMPL: evmAddress,
  ENS_RESOLVER: evmAddress,
  ENS_MOCK_USDC: evmAddress,
  // chosen once, at first registration — see docs/stage-7.md for why this
  // specific label.
  ENS_PARENT_NAME: z.string().min(1),
  // the subregistry we deployed and own, and the parent name registered
  // under it — both one-time setup, done by `scripts/setup-ens.ts` and
  // never redone. Every studio subname mints against this address.
  ENS_SUBREGISTRY_ADDRESS: evmAddress,
})
  // A route that moves real money out of the operator account on nothing but
  // a valid login has no business existing in production. Making it a boot
  // failure rather than a runtime check means it cannot be turned on by
  // accident and noticed later.
  .refine((e) => !(e.DEV_FAUCET === "on" && e.NODE_ENV === "production"), {
    message: "DEV_FAUCET cannot be 'on' when NODE_ENV is 'production'",
    path: ["DEV_FAUCET"],
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
