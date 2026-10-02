import type { Address } from "viem";
import { env } from "../../../config/env.js";
import { privyViemAccount, payGatedResource } from "./payer.js";

/**
 * The agent paying for things, with a wallet this server may sign for.
 *
 * That is the agent's own wallet — we created it, so we have authority over it.
 * A person's embedded wallet is never one of these; see browserPay.ts for why
 * that half has to happen in the browser.
 *
 * Both calls go out over HTTP against our own x402-gated routes, exactly as a
 * stranger's client would. Nothing here knows how settlement works: it reads a
 * 402, signs the authorization it describes, and retries.
 */

type AgentWallet = { agentWalletId: string; agentEvmAddress: string };

const gameUrl = (gameId: string) => `http://127.0.0.1:${env.PORT}/api/games/${gameId}/download`;
const verdictUrl = () => `http://127.0.0.1:${env.PORT}/api/agent/verdict`;

const accountFor = (agent: AgentWallet) =>
  privyViemAccount(agent.agentWalletId, agent.agentEvmAddress as Address);

/**
 * Buy a game on behalf of the person who funded this agent.
 *
 * `ownerAddress` is that person: the agent pays, and the GameKey has to land
 * with them, or the purchase is pointless.
 */
export async function payForGame(
  gameId: string,
  agent: AgentWallet,
  ownerAddress: string,
): Promise<unknown> {
  const result = await payGatedResource(gameUrl(gameId), accountFor(agent), {
    ownerAddress: ownerAddress as Address,
  });
  return result.body;
}

/**
 * Pay for one verdict from the agent's own decision endpoint — the literal
 * meaning of "inference is metered over x402". A real settlement on the same
 * rails as buying a game, on a route that answers with a recommendation rather
 * than a build.
 *
 * Deliberately carries no request body: the route re-derives which agent is
 * asking from who signed the payment, and recomputes that agent's wants and
 * balance fresh rather than trusting a snapshot from this process.
 */
export async function payForVerdict(
  agent: AgentWallet,
): Promise<{ verdict: unknown; costUnits: number; settlementTxId?: string }> {
  const result = await payGatedResource(verdictUrl(), accountFor(agent));
  return result.body as { verdict: unknown; costUnits: number; settlementTxId?: string };
}
