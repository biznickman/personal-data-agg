export const BLOCKED_ACCOUNTS: ReadonlySet<string> = new Set([
  "crystalfoxeth",
  "0xkevinrich",
  "tomcrypto_web3",
  "davidguapo",
  "wojaksx",
  "bullish__degen",
  "aytanzania",
]);

export function isBlockedAccount(username: string | null): boolean {
  if (!username) return false;
  return BLOCKED_ACCOUNTS.has(username.toLowerCase());
}
