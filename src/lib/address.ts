// The only display fallback for an identity until Stage 7 (ENS) exists —
// nobody has an ENS name to show yet, studios or otherwise.
export function truncateAddress(address: string): string {
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
