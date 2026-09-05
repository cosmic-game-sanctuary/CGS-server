import { Client, PrivateKey } from "@hiero-ledger/sdk";
import { env } from "../../config/env.js";

// one operator client for the whole process. This account pays for and signs
// every write the backend itself makes (topic messages, HTS operations) —
// it's not a buyer's or a studio's wallet.
const client =
  env.HEDERA_NETWORK === "mainnet" ? Client.forMainnet() : Client.forTestnet();

// portal.hedera.com hands out ECDSA keys as raw hex with a "0x" prefix (the
// EVM-style format, since these accounts are EVM-compatible from creation).
// PrivateKey.fromString's generic auto-detection is built for DER-encoded or
// unprefixed hex and gets this one wrong — go straight to the ECDSA parser.
const operatorKey = PrivateKey.fromStringECDSA(env.HEDERA_OPERATOR_KEY.replace(/^0x/, ""));
client.setOperator(env.HEDERA_OPERATOR_ID, operatorKey);

export default client;
