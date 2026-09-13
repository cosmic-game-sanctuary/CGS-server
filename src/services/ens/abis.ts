// Minimal ABIs — only the functions this project calls. Pulled from
// ensdomains/contracts-v2 @ 48b3e2d (2026-07-03) source and its deployment
// JSON, not written from memory. See docs/stage-7.md for how each address
// was independently verified against a live Sepolia RPC before being trusted.

export const erc20Abi = [
  {
    name: "mint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// IETHRegistrar
export const ethRegistrarAbi = [
  {
    name: "isAvailable",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "label", type: "string" }],
    outputs: [{ type: "bool" }],
  },
  {
    name: "getRegisterPrice",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "label", type: "string" },
      { name: "duration", type: "uint64" },
      { name: "paymentToken", type: "address" },
    ],
    outputs: [
      { name: "base", type: "uint256" },
      { name: "premium", type: "uint256" },
    ],
  },
  {
    name: "makeCommitment",
    type: "function",
    stateMutability: "pure",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "secret", type: "bytes32" },
      { name: "subregistry", type: "address" },
      { name: "resolver", type: "address" },
      { name: "duration", type: "uint64" },
      { name: "referrer", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    name: "commit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "commitment", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "secret", type: "bytes32" },
      { name: "subregistry", type: "address" },
      { name: "resolver", type: "address" },
      { name: "duration", type: "uint64" },
      { name: "paymentToken", type: "address" },
      { name: "referrer", type: "bytes32" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

// VerifiableFactory. Full function list confirmed against the real
// deployment ABI — deployProxy, proxyLogic(), verifyContract() are the only
// three functions; there's no address-prediction view function, so the
// deployed proxy's address comes from the ProxyDeployed event instead.
export const verifiableFactoryAbi = [
  {
    name: "deployProxy",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "implementation", type: "address" },
      { name: "salt", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "proxy", type: "address" }],
  },
  {
    name: "ProxyDeployed",
    type: "event",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "proxyAddress", type: "address", indexed: true },
      { name: "salt", type: "uint256", indexed: false },
      { name: "implementation", type: "address", indexed: false },
    ],
  },
] as const;

// UserRegistry's initializer — encoded as the `data` param to deployProxy,
// never called directly (the factory calls it on our behalf during deploy).
/**
 * `UserRegistryImpl.initialize`, as deployed for the ETHOnline hackathon.
 *
 * Takes a list of `{account, roleBitmap}` grants applied to `ROOT_RESOURCE` —
 * not the beta's flat `(address admin, uint256 roleBitmap)`. Passing the old
 * shape encodes to a different selector and reverts inside the proxy's
 * delegatecall, which surfaces only as a bare "execution reverted".
 *
 * Unlike the resolver's initializer there is no trailing `calls` array.
 */
export const userRegistryInitAbi = [
  {
    name: "initialize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "grants",
        type: "tuple[]",
        components: [
          { name: "account", type: "address" },
          { name: "roleBitmap", type: "uint256" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// PermissionedRegistry.register — how a subregistry we own mints a subname
// (a studio's handle) under itself.
export const permissionedRegistryAbi = [
  {
    // Who holds a subname, straight from the registry. This is what makes a
    // name *resolve* rather than merely exist: ENSv2 keeps ownership in the
    // registry that issued the name, so this is the authoritative answer for
    // anything minted under our parent — no v1 resolver in the path.
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "label", type: "string" },
      { name: "owner", type: "address" },
      { name: "registry", type: "address" },
      { name: "resolver", type: "address" },
      { name: "roleBitmap", type: "uint256" },
      { name: "expiry", type: "uint64" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * ENSv2's Permissioned Resolver.
 *
 * `initialize` takes the admin, a role bitmap and an array of initial setter
 * calls — deployed per account through the same `VerifiableFactory` the
 * subregistry uses, so every name we issue can point at a resolver we control
 * outright rather than a shared one we have no roles on.
 *
 * Record getters and setters key on the **namehash** (`bytes32`), the same as
 * v1. Only the authorization surface (`authorizeTextRoles`) takes a
 * DNS-encoded name, which is why both shapes appear here.
 */
/**
 * ENSv2's **Permissioned Resolver**, as deployed for the ETHOnline hackathon.
 *
 * **Setters take a DNS-encoded name (`bytes`), not a namehash.** That is the
 * single biggest difference from both v1 and from the earlier v2 beta, and it
 * is not cosmetic: the resolver derives the node from the name itself, so the
 * node argument that still appears in the *read* profiles is ignored. Use
 * `viem/ens`'s `packetToBytes` to produce the encoding rather than hand-rolling
 * length-prefixed labels.
 *
 * Addresses are ENSIP-9 multichain: `setAddress(name, coinType, bytes)` with
 * coin type 60 for Ethereum and the address as raw 20 bytes, rather than v1's
 * `setAddr(bytes32, address)`.
 *
 * `initialize` takes a list of `Grant` structs (an account plus a role bitmap,
 * applied to `ROOT_RESOURCE`) and a multicall batch executed with role checks
 * skipped — not the beta's flat `(admin, roleBitmap, bytes[])`.
 */
export const permissionedResolverAbi = [
  {
    name: "initialize",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "grants",
        type: "tuple[]",
        components: [
          { name: "account", type: "address" },
          { name: "roleBitmap", type: "uint256" },
        ],
      },
      { name: "calls", type: "bytes[]" },
    ],
    outputs: [],
  },
  {
    name: "setAddress",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "coinType", type: "uint256" },
      { name: "addressBytes", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "setText",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "key", type: "string" },
      { name: "value", type: "string" },
    ],
    outputs: [],
  },
  // Read profiles. Passed as the `data` argument to `resolve(name, data)`
  // rather than called directly — the resolver has no standalone getters.
  {
    name: "addr",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "coinType", type: "uint256" },
    ],
    outputs: [{ type: "bytes" }],
  },
  {
    name: "text",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "key", type: "string" },
    ],
    outputs: [{ type: "string" }],
  },
  {
    name: "resolve",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ type: "bytes" }],
  },
  // Delegate exactly one text key (or coin type) to another account. `setter`
  // is ABI-encoded calldata of the setter being authorised; only its selector
  // and the keyed argument are read.
  {
    name: "grantSetterRoles",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "setter", type: "bytes" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "hasRootRoles",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** `setResolver` on our own subregistry, so a name can be repointed after it
 *  was issued rather than having to be registered again. */
export const registrySetResolverAbi = [
  {
    name: "setResolver",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenId", type: "uint256" },
      { name: "resolver", type: "address" },
    ],
    outputs: [],
  },
] as const;


/** EAC role management, shared by registries and resolvers. Needed to revoke a
 *  role that was granted at registration time — see `roles.ts#AGENT_BITMAP`. */
export const eacAbi = [
  {
    name: "revokeRoles",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "resource", type: "uint256" },
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    name: "hasRoles",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "resource", type: "uint256" },
      { name: "roleBitmap", type: "uint256" },
      { name: "account", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
