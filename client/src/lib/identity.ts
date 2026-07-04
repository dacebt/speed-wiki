// The client's stable, unauthenticated identity. A playerId is generated once
// and persisted so a refresh or reconnect keeps your seat: the server keys
// players by it (see shared/src/messages.ts). The name and last-room code are
// persisted alongside it so a reconnect can re-send room/join without prompting.
// This is a convenience id, not a credential.

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
