// Player name is a browser preference. The Room-scoped Membership and its
// discoverable last-Room pointer are persisted separately by the transport.

const PLAYER_NAME_KEY = 'wikispeedrun.playerName';
const LAST_ROOM_KEY = 'wikispeedrun.lastRoom';

export function getPlayerName(): string {
  return localStorage.getItem(PLAYER_NAME_KEY) ?? '';
}

export function setPlayerName(name: string): void {
  localStorage.setItem(PLAYER_NAME_KEY, name);
}

export function getLastRoom(): string | null {
  return localStorage.getItem(LAST_ROOM_KEY);
}

export function setLastRoom(code: string): void {
  localStorage.setItem(LAST_ROOM_KEY, code);
}

export function clearLastRoom(): void {
  localStorage.removeItem(LAST_ROOM_KEY);
}
