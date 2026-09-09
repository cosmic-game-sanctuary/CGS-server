import { z } from "zod";
import { env } from "../../config/env.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import { wireOf, type EligibleWant, type PendingWant, type RawVerdict } from "./decide.js";
import logger from "../../utils/logger.utils.js";

/**
 * The only place this codebase calls a model. Plain `fetch` against Groq's
 * OpenAI-compatible endpoint — no SDK, the same call an `x402`-paying client
 * would make, kept hand-rolled the way HCS-14 identity is (see CLAUDE.md):
 * one JSON request, one JSON response, nothing to install.
 *
 * https://console.groq.com/docs/text-chat, https://console.groq.com/docs/structured-outputs
 */

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// What the model is required to return. `strict: true` plus this schema means
// Groq itself refuses to emit anything that doesn't match — every field
// listed in `required` because strict mode doesn't support optional
// properties, so "buying nothing this round" is an empty `buyNow` array
// rather than an absent field.
const verdictJsonSchema = {
  type: "object",
  properties: {
    buyNow: { type: "array", items: { type: "string" }, description: "gameIds to buy right now" },
    decline: { type: "array", items: { type: "string" }, description: "gameIds to pass on this round" },
    askFirst: {
      type: "boolean",
      description: "true only if genuinely torn on buyNow and a person's input would change it",
    },
    reasoning: { type: "string", description: "one or two sentences, plain language, for the person funding this" },
  },
  required: ["buyNow", "decline", "askFirst", "reasoning"],
  additionalProperties: false,
};

export const rawVerdictSchema = z.object({
  buyNow: z.array(z.string()),
  decline: z.array(z.string()),
  askFirst: z.boolean(),
  reasoning: z.string(),
}) satisfies z.ZodType<RawVerdict>;

/** A want the budget cannot reach yet, as one line of context. */
function describePending(w: PendingWant): string {
  const usd = toDisplayAmount(w.currentPriceUnits, w.asset);
  const maxUsd = toDisplayAmount(w.agentMaxUnits, w.asset);
  const decimals = assetDecimals(w.asset);
  const parts = [
    `"${w.title}"`,
    `price $${usd.toFixed(decimals)}`,
    `they would pay up to $${maxUsd.toFixed(decimals)}`,
  ];
  if (w.promotionEndsAt) parts.push(`on sale until ${w.promotionEndsAt.toISOString()}`);
  if (w.note) parts.push(`buyer's note: "${w.note}"`);
  return `- ${parts.join(", ")}`;
}

function describeWant(w: EligibleWant, now: Date): string {
  const usd = toDisplayAmount(w.currentPriceUnits, w.asset);
  const maxUsd = toDisplayAmount(w.agentMaxUnits, w.asset);
  const lowestUsd = toDisplayAmount(w.lowestEverUnits, w.asset);
  const decimals = assetDecimals(w.asset);
  const parts = [
    `id ${w.gameId}`,
    `"${w.title}"`,
    `price $${usd.toFixed(decimals)}`,
    `your max $${maxUsd.toFixed(decimals)}`,
    `lowest ever $${lowestUsd.toFixed(decimals)}`,
  ];

  // The single most important fact in the whole prompt: whether passing on
  // this one is reversible. Everything else is preference; this is the cost of
  // being wrong. Stated as a phrase rather than a timestamp the model has to
  // do arithmetic on against `now`.
  const wire = wireOf(w);
  if (!w.promotionEndsAt) {
    parts.push("no sale running, this price has no end date");
  } else if (wire && wire.getTime() <= now.getTime()) {
    parts.push(`LAST CHANCE, sale ends ${w.promotionEndsAt.toISOString()} and this is the final round at this price`);
  } else {
    const hours = (wire!.getTime() - now.getTime()) / 3_600_000;
    parts.push(`sale ends ${w.promotionEndsAt.toISOString()}, its own last-chance round is ${hours.toFixed(1)}h away`);
  }

  if (w.note) parts.push(`buyer's note: "${w.note}"`);
  return `- ${parts.join(", ")}`;
}

const SYSTEM_PROMPT = [
  "You allocate a fixed, real budget across a person's wishlisted games on their behalf. You are not a chatbot; you return exactly one JSON object matching the given schema and nothing else.",
  "",
  "Hard constraints. Violating any of these makes your answer void and a deterministic fallback runs instead, so there is no reason to bend them:",
  "- Never include a gameId in buyNow whose total cost (summed with every other buyNow game) exceeds the stated balance.",
  '- Only use gameIds from the "Can buy now" list. Games under "Also wanted" are context, not things you can buy.',
  "- A gameId appears in at most one of buyNow and decline.",
  "- Set askFirst true only when you are genuinely torn between comparably good options and a person's answer would actually change what happens. Not for every decision.",
  "",
  "**You are being asked at a scheduled moment, not at a random one.** This agent does not spend the instant something gets cheap. It waits, on purpose, until the last responsible moment before the soonest deadline it is watching, so that when it does choose it can see everything that arrived while it waited. That moment is now. Do not ask for more time; there is no mechanism to give it to you, and there will not be a better-informed round before the deadline below.",
  "",
  "**Read the marker on each game.** A game marked LAST CHANCE has a sale ending within the hour: this is the final round in which it can be had at this price, so declining it is a real and permanent decision, not a deferral. A game whose own last-chance round is still hours away will be put to you again, on its own, when that round arrives. Declining one of those costs almost nothing, because you get to decide about it later with better information, and by then this money may not be spoken for.",
  "",
  "That asymmetry is the heart of the call. When the budget cannot cover everything, the game at LAST CHANCE is usually the one to take, because it is the only one you cannot come back to. Spend on a game that still has time only when it is clearly the better game for this person: their note points at it, its price is far below its lowest ever, or the last-chance one is a poor fit for what they said they wanted.",
  "",
  "Decline freely when the money is better kept. An empty buyNow is a legitimate answer if nothing here is worth what it forecloses.",
  "",
  "Weigh how soon each sale ends, how the current price compares to the lowest ever, how much of their whole list you could satisfy overall, and the buyer's own note. Their words about what they care about outrank every other signal.",
  "",
  "Write reasoning for the person whose money this is: one or two plain sentences naming what you chose and what you gave up. **Name each game by its title, in quotes.** LAST CHANCE is a marker in this prompt, not part of any game's name, and a sentence like \"I chose the LAST CHANCE game\" is unreadable to someone who cannot see this prompt. Do not mention gameIds either.",
].join("\n");

/**
 * One verdict, over one contested round. Throws on anything that isn't a
 * clean, schema-valid response — the caller's job is to catch that and fall
 * back to the deterministic plan (rule 7), not to guess at a partial answer.
 */
export async function callAgentModel(input: {
  eligible: EligibleWant[];
  /**
   * What else this person wants but cannot have at today's prices.
   *
   * Not buyable, and deliberately listed without ids so a model cannot put one
   * in `buyNow` by mistake. They are here because they are what makes the
   * balance scarce: without them, every purchase looks free.
   */
  pending: PendingWant[];
  balanceUnits: bigint;
  asset: string;
}): Promise<RawVerdict> {
  // Guarded at both call sites already (the route refuses before charging,
  // the watcher falls back before paying). Repeated here so this function is
  // safe to call from anywhere without silently sending "Bearer undefined".
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not configured");

  const decimals = assetDecimals(input.asset);
  const balanceUsd = toDisplayAmount(Number(input.balanceUnits), input.asset);
  const now = new Date();
  const nowIso = now.toISOString();
  // Named without ids, so a model cannot reach for one of these in `buyNow`.
  const pendingBlock = input.pending.length
    ? [
        "",
        "",
        "Also wanted, but above their maximum at today's price. You cannot buy these now,",
        "and they are why this balance is not spare money:",
        ...input.pending.map(describePending),
      ].join("\n")
    : "\n\nNothing else is on their list, so this balance is not needed for anything else.";

  const userPrompt = [
    `Right now it is ${nowIso}.`,
    `Wallet balance: $${balanceUsd.toFixed(decimals)}.`,
    "",
    "Can buy now:",
    ...input.eligible.map((want) => describeWant(want, now)),
  ].join("\n") + pendingBlock;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response: Response;
  try {
    response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: env.GROQ_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "agent_verdict", strict: true, schema: verdictJsonSchema },
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Groq returned ${response.status}: ${body.slice(0, 500)}`);
  }

  const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = body.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq response had no message content");

  const parsed = rawVerdictSchema.safeParse(JSON.parse(content));
  if (!parsed.success) {
    logger.warn({ issues: parsed.error.issues, content }, "Groq verdict failed schema validation");
    throw new Error("Groq verdict did not match the required schema");
  }
  return parsed.data;
}
