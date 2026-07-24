// The legacy runtime's client-generated identity. The Worker runtime instead
// persists a Room-scoped Membership issued by the Room authority. The shared
// player name and last-Room code support both transports.

const PLAYER_ID_KEY = 'wikispeedrun.playerId';
const PLAYER_NAME_KEY = 'wikispeedrun.playerName';
const LAST_ROOM_KEY = 'wikispeedrun.lastRoom';

export function getPlayerId(): string {
  let id = localStorage.getItem(PLAYER_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(PLAYER_ID_KEY, id);
  }
  return id;
}

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
