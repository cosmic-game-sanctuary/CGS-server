import "dotenv/config";
import { z } from "zod";

// a real 0.0.x account id, not .env.example's `0.0.xxxxx` placeholder
const hederaAccountId = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, "must be a real Hedera account id like 0.0.12345");

const evmAddress = z.string().regex(/^0x[a-fA-F0-9]{40}$/, "must be a real 0x address");

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
  PRIVY_VERIFICATION_KEY: z.string(),

  PINATA_JWT: z.string(),

  // no CSAM-scanning provider is wired yet (see docs/api-contract.md §6). This
  // fails closed on purpose — "skip" is a deliberate local escape hatch, not
  // a default, and it stays "block" until a real provider is chosen.
  CSAM_MODE: z.enum(["block", "skip"]).default("block"),

  AGENT_POLL_INTERVAL_MS: z.coerce.number().default(5000),

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
