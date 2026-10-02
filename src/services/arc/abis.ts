// Hand-written from CGS-contracts/src, which is small enough to read in one
// sitting. scripts/arc-chain-check.ts calls every function listed here against
// the deployed contracts, so a drift between the two repos fails loudly.

export const gameRegistryAbi = [
  {
    type: "function",
    name: "publish",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "bytes32" },
      { name: "slug", type: "string" },
      { name: "priceUnits", type: "uint256" },
      { name: "vault", type: "address" },
      { name: "buildCid", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "delist",
    stateMutability: "nonpayable",
    inputs: [{ name: "gameId", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "setPrice",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "bytes32" },
      { name: "fromUnits", type: "uint256" },
      { name: "toUnits", type: "uint256" },
      { name: "endsAt", type: "uint64" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "updateBuild",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "bytes32" },
      { name: "version", type: "uint32" },
      { name: "buildCid", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "relist",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "bytes32" },
      { name: "priceUnits", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "announceDemand",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "bytes32" },
      { name: "wishlistCount", type: "uint32" },
      { name: "milestone", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "vaultOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "delisted",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "operator",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "event",
    name: "Listed",
    inputs: [
      { name: "gameId", type: "bytes32", indexed: true },
      { name: "slug", type: "string", indexed: false },
      { name: "priceUnits", type: "uint256", indexed: false },
      { name: "vault", type: "address", indexed: false },
      { name: "buildCid", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PriceChanged",
    inputs: [
      { name: "gameId", type: "bytes32", indexed: true },
      { name: "fromUnits", type: "uint256", indexed: false },
      { name: "toUnits", type: "uint256", indexed: false },
      { name: "endsAt", type: "uint64", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BuildUpdated",
    inputs: [
      { name: "gameId", type: "bytes32", indexed: true },
      { name: "version", type: "uint32", indexed: false },
      { name: "buildCid", type: "string", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Delisted",
    inputs: [{ name: "gameId", type: "bytes32", indexed: true }],
  },
  {
    type: "event",
    name: "Relisted",
    inputs: [
      { name: "gameId", type: "bytes32", indexed: true },
      { name: "priceUnits", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Demand",
    inputs: [
      { name: "gameId", type: "bytes32", indexed: true },
      { name: "wishlistCount", type: "uint32", indexed: false },
      { name: "milestone", type: "uint32", indexed: false },
    ],
  },
  { type: "error", name: "NotOperator", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "AlreadyPublished", inputs: [] },
  { type: "error", name: "NotPublished", inputs: [] },
  { type: "error", name: "AlreadyDelisted", inputs: [] },
  { type: "error", name: "NotDelisted", inputs: [] },
] as const;

export const gameKeyAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "gameId", type: "bytes32" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "minter",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "gameOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "tokenOfOwnerByIndex",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
  {
    type: "function",
    name: "keysOf",
    stateMutability: "view",
    inputs: [{ name: "holder", type: "address" }],
    outputs: [
      { name: "tokenIds", type: "uint256[]" },
      { name: "gameIds", type: "bytes32[]" },
    ],
  },
  {
    type: "function",
    name: "keyFor",
    stateMutability: "view",
    inputs: [
      { name: "holder", type: "address" },
      { name: "gameId", type: "bytes32" },
    ],
    outputs: [{ type: "uint256" }],
  },
  { type: "error", name: "NotMinter", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "ERC721InvalidReceiver", inputs: [{ name: "receiver", type: "address" }] },
] as const;

export const splitVaultAbi = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [],
  },
  // Anyone may call this, and the money still goes only to `payee`. It is how
  // a developer whose first earnings are in the vault gets paid at all: gas on
  // Arc is USDC, so they cannot afford the transaction `claim()` would need.
  {
    type: "function",
    name: "claimFor",
    stateMutability: "nonpayable",
    inputs: [{ name: "payee", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "payeeCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "payees",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "bpsOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint16" }],
  },
  {
    type: "function",
    name: "claimed",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "remainderPayee",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "totalReceived",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "owed",
    stateMutability: "view",
    inputs: [{ name: "payee", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "claimable",
    stateMutability: "view",
    inputs: [{ name: "payee", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "event",
    name: "Claimed",
    inputs: [
      { name: "payee", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  { type: "error", name: "NothingOwed", inputs: [] },
  { type: "error", name: "TransferFailed", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
] as const;

export const vaultFactoryAbi = [
  {
    type: "function",
    name: "deploy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "gameId", type: "bytes32" },
      { name: "recipients", type: "address[]" },
      { name: "bps", type: "uint16[]" },
      { name: "platform", type: "address" },
      { name: "platformBps", type: "uint16" },
    ],
    outputs: [{ name: "vault", type: "address" }],
  },
  {
    type: "function",
    name: "vaultOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ type: "address" }],
  },
  {
    type: "event",
    name: "VaultDeployed",
    inputs: [
      { name: "gameId", type: "bytes32", indexed: true },
      { name: "vault", type: "address", indexed: false },
      { name: "payees", type: "address[]", indexed: false },
      { name: "bps", type: "uint16[]", indexed: false },
    ],
  },
  // SplitVault's constructor reverts bubble up through the factory, so the
  // factory's callers need to be able to name them too.
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "DuplicateRecipient", inputs: [] },
  { type: "error", name: "BpsOverflow", inputs: [] },
  { type: "error", name: "BpsMismatch", inputs: [] },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint8" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
] as const;
