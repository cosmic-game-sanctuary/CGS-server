import { env } from "../config/env.js";

// Values the API sends purely so a client can render them. Nothing here is
// ever used for arithmetic on this side, and nothing downstream should do
// arithmetic on what these produce either — the integer units stay the source
// of truth everywhere (INTEGRATION.md §7).

export function assetDecimals(asset: string): number {
  if (asset === "0.0.0") return 8; // HBAR, in tinybars
  return env.X402_ASSET_DECIMALS;
}

// A float is the wrong type for money and the right type for a price tag. The
// client needs one and can't derive it: the decimals live only in this env,
// and the contract tells clients never to hardcode anything about the asset.
export function toDisplayAmount(units: number, asset: string): number {
  return units / 10 ** assetDecimals(asset);
}

// `studios.ens_subname` stores the bare label a studio chose. What anyone
// types or reads is the full name under our parent, so resolve it here rather
// than making every client reassemble it from a constant it would have to be
// told separately.
export function ensFullName(label: string | null): string | null {
  return label ? `${label}.${env.ENS_PARENT_NAME}.eth` : null;
}
