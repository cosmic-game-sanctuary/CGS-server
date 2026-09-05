import { createHash } from "node:crypto";
import { submitTopicMessage } from "../hedera/hcs.js";
import { env } from "../../config/env.js";

// `@hashgraphonline/standards-sdk` is the reference implementation of HCS-14,
// and it was tried first — its install alone took over 4 minutes and never
// finished in this environment, which is a real cost against a build clock,
// not a style preference. The AID variant's own spec is explicit that "any
// party shall be able to derive the identifier from canonical public inputs
// without permission" — no registry call, no SDK, just SHA-384 and Base58 —
// so it's implemented directly here instead. Format verified against
// hol.org/docs/standards/hcs-14, not guessed:
//
//   uaid:aid:{base58(sha384(canonicalJSON))};uid={uid};registry={registry};proto={protocol};nativeId={nativeId}
//
// where the canonical JSON holds exactly six fields, keys alphabetical:
// name, nativeId, protocol, registry, skills, version.

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58Encode(buffer: Buffer): string {
  let value = BigInt(`0x${buffer.toString("hex")}`);
  const base = BigInt(58);
  let out = "";
  while (value > 0n) {
    out = BASE58_ALPHABET[Number(value % base)] + out;
    value /= base;
  }
  for (const byte of buffer) {
    if (byte !== 0) break;
    out = `${BASE58_ALPHABET[0]}${out}`;
  }
  return out || BASE58_ALPHABET[0]!;
}

type AidCanonicalFields = {
  name: string;
  nativeId: string;
  protocol: string;
  registry: string;
  skills: string[];
  version: string;
};

function buildAid(fields: AidCanonicalFields, uid: string): string {
  // object literal order matches the spec's required alphabetical order —
  // not a coincidence, chosen so JSON.stringify needs no extra sorting step.
  const canonical = {
    name: fields.name,
    nativeId: fields.nativeId,
    protocol: fields.protocol,
    registry: fields.registry,
    skills: fields.skills,
    version: fields.version,
  };
  const hash = createHash("sha384").update(JSON.stringify(canonical)).digest();
  const id = base58Encode(hash);
  return `uaid:aid:${id};uid=${uid};registry=${fields.registry};proto=${fields.protocol};nativeId=${fields.nativeId}`;
}

// Anchors the agent's identity on the public HCS_AGENT_IDENTITY_TOPIC, naming
// the buyer as funding principal. This is what "the agent has its own
// on-chain identity" means as code, not marketing language — anyone watching
// this topic through the Mirror Node can independently verify which human
// funds which agent, without asking us.
export async function anchorAgentIdentity(
  agentId: string,
  agentAccountId: string,
  buyerAccountId: string,
): Promise<{ aid: string; txId: string }> {
  const aid = buildAid(
    {
      name: "cgs-wishlist-agent",
      nativeId: `${env.X402_NETWORK}:${agentAccountId}`,
      // "rest" is the honest fit, not a stretch: this agent transacts by
      // calling our REST API, not by speaking the HCS-10 agent-message
      // protocol. The spec's protocol list is stated as a non-exhaustive
      // starting point, not a closed enum.
      protocol: "rest",
      registry: "cgs",
      skills: ["purchase"],
      version: "1",
    },
    agentId,
  );

  const txId = await submitTopicMessage(env.HCS_AGENT_IDENTITY_TOPIC!, {
    aid,
    agentAccountId,
    fundingPrincipal: buyerAccountId,
    anchoredAt: new Date().toISOString(),
  });

  return { aid, txId };
}
