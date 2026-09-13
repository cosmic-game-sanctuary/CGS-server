// Exact values from RegistryRolesLib.sol, ensdomains/contracts-v2 @ 48b3e2d
// (2026-07-03) — never guessed, matching the project's own rule about these
// bitmaps. Each role is one nybble; its admin counterpart is the same value
// shifted 128 bits.
export const ROLE_REGISTRAR = 1n << 0n;
export const ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128n;
export const ROLE_SET_SUBREGISTRY = 1n << 20n;
export const ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128n;
export const ROLE_SET_RESOLVER = 1n << 24n;
export const ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128n;
export const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;
export const ROLE_RENEW = 1n << 16n;
export const ROLE_RENEW_ADMIN = ROLE_RENEW << 128n;
export const ROLE_UNREGISTER = 1n << 12n;
export const ROLE_UNREGISTER_ADMIN = ROLE_UNREGISTER << 128n;
export const ROLE_UPGRADE = 1n << 124n;
export const ROLE_UPGRADE_ADMIN = ROLE_UPGRADE << 128n;

// Full control over a subregistry we deploy and own outright.
export const FULL_ADMIN_BITMAP =
  ROLE_REGISTRAR |
  ROLE_REGISTRAR_ADMIN |
  ROLE_SET_SUBREGISTRY |
  ROLE_SET_SUBREGISTRY_ADMIN |
  ROLE_SET_RESOLVER |
  ROLE_SET_RESOLVER_ADMIN |
  ROLE_CAN_TRANSFER_ADMIN |
  ROLE_RENEW |
  ROLE_RENEW_ADMIN |
  ROLE_UNREGISTER |
  ROLE_UNREGISTER_ADMIN |
  ROLE_UPGRADE |
  ROLE_UPGRADE_ADMIN;

// What a studio gets on its own subname: enough to point their name
// somewhere and keep it renewed, not enough to unregister or transfer it out
// from under the platform's control — that stays with the operator, same
// spirit as GameKey treasury staying with the operator rather than the studio.
export const STUDIO_BITMAP = ROLE_SET_RESOLVER | ROLE_RENEW;

// Identical scope to a studio's, under a different name for clarity at the
// call site — an agent's subname is "each with their own identity and
// permissions" (ENS's own stated bonus for this), not a studio's vanity name,
// even though the actual role set an owner needs is the same either way.
export const AGENT_BITMAP = STUDIO_BITMAP;

/**
 * Every role on a Permissioned Resolver.
 *
 * The resolver has its own role numbering, **separate from the registry's** —
 * a fact learned the expensive way: initialising a resolver with
 * `FULL_ADMIN_BITMAP` (which is the registry's set) deploys fine, lets
 * `setAddr` through, and then reverts on `setText` with
 * `Unauthorized(resource, 0x10, account)`. Bit 4 is the resolver's
 * ROLE_SET_TEXT and simply isn't in the registry's bitmap.
 *
 * `0x1111…1111` is ENS's own documented "all roles" value: EAC lays roles out
 * one per nibble, so a 1 in every nibble grants each of them. Using their
 * constant rather than reconstructing it from individual bits, because the
 * numbering is the resolver's business and not something to infer.
 */
export const ALL_RESOLVER_ROLES =
  0x1111111111111111111111111111111111111111111111111111111111111111n;
