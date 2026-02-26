export const BLOCKED_ACCOUNTS: ReadonlySet<string> = new Set([
  "crystalfoxeth",
  "0xkevinrich",
]);

export function isBlockedAccount(username: string | null): boolean {
  if (!username) return false;
  return BLOCKED_ACCOUNTS.has(username.toLowerCase());
}
