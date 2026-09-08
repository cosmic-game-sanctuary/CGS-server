import { z } from "zod";
import { env } from "../../config/env.js";
import { assetDecimals, toDisplayAmount } from "../../lib/display.js";
import type { EligibleWant, PendingWant, RawVerdict } from "./decide.js";
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
// properties, so "not holding anything" is an empty `hold` array rather than
// an absent field.
const verdictJsonSchema = {
  type: "object",
  properties: {
    buyNow: { type: "array", items: { type: "string" }, description: "gameIds to buy immediately" },
    hold: {
      type: "array",
      items: {
        type: "object",
        properties: {
          gameId: { type: "string" },
          holdHours: { type: "number", description: "how many hours to wait before reconsidering" },
        },
        required: ["gameId", "holdHours"],
        additionalProperties: false,
      },
    },
    decline: { type: "array", items: { type: "string" }, description: "gameIds to pass on this round" },
    askFirst: {
      type: "boolean",
      description: "true only if genuinely torn on buyNow and a person's input would change it",
    },
    reasoning: { type: "string", description: "one or two sentences, plain language, for the person funding this" },
  },
  required: ["buyNow", "hold", "decline", "askFirst", "reasoning"],
  additionalProperties: false,
};

export const rawVerdictSchema = z.object({
  buyNow: z.array(z.string()),
  hold: z.array(z.object({ gameId: z.string(), holdHours: z.number() })),
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

function describeWant(w: EligibleWant): string {
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
  if (w.promotionEndsAt) parts.push(`sale ends ${w.promotionEndsAt.toISOString()}`);
  if (w.note) parts.push(`buyer's note: "${w.note}"`);
  return `- ${parts.join(", ")}`;
}

const SYSTEM_PROMPT = `You allocate a fixed, real budget across a person's wishlisted games on their behalf. You are not a chatbot; you return exactly one JSON object matching the given schema and nothing else.

Hard constraints — violating any of these makes your answer void and a deterministic fallback runs instead, so there is no reason to bend them:
- Never include a gameId in buyNow whose total cost (summed with every other buyNow game) exceeds the stated balance.
- Only use gameIds from the "Can buy now" list. Games under "Also wanted" are context, not things you can buy.
- A gameId appears in at most one of buyNow, hold, or decline.
- Only hold a game that has a stated sale end. A hold with no deadline is just a decline that wastes a round.
- Set askFirst true only when you are genuinely torn between comparably good options and a person's answer would actually change what happens — not for every decision.

**The decision you are making is when to spend, not only what to buy.** A sale stays open until it ends, so waiting costs nothing until then, and money spent now is money not available for anything else this person wants. If buying something now would leave you unable to afford another game on their list, that is a real trade-off and you should usually **hold** rather than take the first thing that happened to get cheap — set holdHours so it resolves shortly before that sale ends, and decide then, when you can see more of what is on offer. Deciding at the wire is the point of being an agent rather than a standing order.

Buy now instead when: the sale ends soon and holding would risk losing it; nothing else on their list is competing for the money; the price is at or near the lowest this game has ever been and unlikely to be beaten; or the buyer's note makes this one clearly their priority.

Weigh how soon each sale ends, how the current price compares to the lowest ever, how much of their list you could satisfy overall, and the buyer's own note — their words about what they care about outrank every other signal.`;

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
  const nowIso = new Date().toISOString();
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
    ...input.eligible.map(describeWant),
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
