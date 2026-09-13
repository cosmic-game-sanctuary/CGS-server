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

/**
 * What an agent gets on its own subname: **renewal only, deliberately not
 * `ROLE_SET_RESOLVER`.**
 *
 * This used to equal `STUDIO_BITMAP`, and that was wrong in a way that
 * undermined the whole point of publishing a mandate. An agent's spending
 * ceiling lives in the text records its name resolves to, so an agent holding
 * `ROLE_SET_RESOLVER` could point its name at a resolver of its own and state
 * any ceiling it liked. A limit the constrained party can rewrite is not a
 * limit, and anyone reading the name's roles could see that for themselves.
 *
 * A studio keeps `ROLE_SET_RESOLVER` because a studio name is an identity its
 * owner genuinely owns and nothing enforceable hangs off its records. An agent
 * name carries a permission, so the account being permitted must not be able
 * to move where that permission is read from. The asymmetry is the point, not
 * an oversight.
 */
export const AGENT_BITMAP = ROLE_RENEW;

/**
 * The **resolver's** own role numbering — separate from the registry's, and a
 * distinction that has already cost one debugging session: initialising a
 * resolver with `FULL_ADMIN_BITMAP` (the registry's set) deploys fine, lets an
 * address write through, then reverts on the first text record with
 * `Unauthorized(resource, 0x10, account)`, because bit 4 is the resolver's
 * `ROLE_SET_TEXT` and simply is not in the registry's bitmap.
 *
 * Values from the Permissioned Resolver docs for the ETHOnline hackathon
 * deployment. Each role also has an admin counterpart at `role << 128`, which
 * is what permits granting or revoking that role to somebody else later.
 */
export const RESOLVER_ROLE_SET_ADDRESS = 1n << 0n;
export const RESOLVER_ROLE_SET_TEXT = 1n << 4n;
export const RESOLVER_ROLE_SET_CONTENTHASH = 1n << 8n;
export const RESOLVER_ROLE_SET_ABI = 1n << 12n;
export const RESOLVER_ROLE_SET_INTERFACE = 1n << 16n;
export const RESOLVER_ROLE_SET_NAME = 1n << 20n;
export const RESOLVER_ROLE_SET_DATA = 1n << 24n;
export const RESOLVER_ROLE_LINK = 1n << 28n;
export const RESOLVER_ROLE_CAN_NAME = 1n << 120n;
export const RESOLVER_ROLE_UPGRADE = 1n << 124n;

const RESOLVER_REGULAR_ROLES =
  RESOLVER_ROLE_SET_ADDRESS |
  RESOLVER_ROLE_SET_TEXT |
  RESOLVER_ROLE_SET_CONTENTHASH |
  RESOLVER_ROLE_SET_ABI |
  RESOLVER_ROLE_SET_INTERFACE |
  RESOLVER_ROLE_SET_NAME |
  RESOLVER_ROLE_SET_DATA |
  RESOLVER_ROLE_LINK |
  RESOLVER_ROLE_CAN_NAME |
  RESOLVER_ROLE_UPGRADE;

/**
 * Every resolver role plus its admin counterpart, granted to the operator on
 * `ROOT_RESOURCE` at deploy time.
 *
 * The admin half matters beyond completeness: it is what lets the operator
 * later hand one specific text key to one account via `grantSetterRoles`
 * without surrendering anything else.
 */
export const ALL_RESOLVER_ROLES =
  RESOLVER_REGULAR_ROLES | (RESOLVER_REGULAR_ROLES << 128n);

/**
 * ENS's own documented "every role" value, used for the grants passed to both
 * `UserRegistryImpl.initialize` and `PermissionedResolverImpl.initialize`.
 *
 * EAC lays roles out one per nibble, so a 1 in every nibble grants each of
 * them — including roles a given contract does not define and any added later.
 * Their constant is used verbatim rather than reconstructed from the named
 * bits above, because the numbering belongs to the contract rather than to us,
 * and a reconstruction silently stops being "all" the moment ENS adds a role.
 */
export const ALL_ROLES =
  0x1111111111111111111111111111111111111111111111111111111111111111n;
