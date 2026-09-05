import "dotenv/config";
import { z } from "zod";

// fails loudly at boot if something's missing, instead of an obscure crash
// three requests in.
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string(),
  DATABASE_URL_POOLED: z.string(),

  HEDERA_OPERATOR_ID: z.string(),
  HEDERA_OPERATOR_KEY: z.string(),
  HEDERA_NETWORK: z.enum(["testnet", "mainnet"]).default("testnet"),
  HEDERA_MIRROR_URL: z.string(),

  X402_FACILITATOR_URL: z.string(),
  X402_NETWORK: z.string().default("hedera:testnet"),
  X402_ASSET: z.string(),
  X402_ASSET_DECIMALS: z.coerce.number(),
  X402_PAY_TO: z.string(),

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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
