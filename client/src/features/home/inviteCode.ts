export function readInviteCode(search: string): string {
  const raw = new URLSearchParams(search).get('code') ?? '';
  return raw.trim().toUpperCase();
}
