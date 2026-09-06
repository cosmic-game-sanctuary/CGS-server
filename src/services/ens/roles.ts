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
