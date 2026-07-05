import {
  CATEGORIES,
  DIFFICULTIES,
  type Category,
  type ClientIntent,
  type Difficulty,
  type RoomSettings,
} from '@wikispeedrun/shared';

// Boundary validation: anything arriving over the wire is untrusted until it
// structurally matches a known intent. The core assumes shapes are valid;
// this is the only place that guarantee is established.

// The client generates its own playerId (a UUID). It's untrusted, becomes a map
// key and an event-log entry, so it gets the same length contract as any other
// wire string — an honest id is ~36 chars; anything past this is not one.
const MAX_PLAYER_ID_LENGTH = 64;
function isPlayerId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PLAYER_ID_LENGTH;
}

export function parseClientIntent(raw: unknown): ClientIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case 'room/create':
      return typeof msg.playerName === 'string' && isPlayerId(msg.playerId)
        ? { type: 'room/create', playerName: msg.playerName, playerId: msg.playerId }
        : null;
    case 'room/join':
      return typeof msg.code === 'string' &&
        typeof msg.playerName === 'string' &&
        isPlayerId(msg.playerId)
        ? { type: 'room/join', code: msg.code, playerName: msg.playerName, playerId: msg.playerId }
        : null;
    case 'player/setCosmetics': {
      const c = msg.cosmetics as Record<string, unknown> | undefined;
      return typeof c === 'object' &&
        c !== null &&
        typeof c.faceId === 'string' &&
        typeof c.hatId === 'string'
        ? { type: 'player/setCosmetics', cosmetics: { faceId: c.faceId, hatId: c.hatId } }
        : null;
    }
    case 'room/setSettings': {
      // Structural only — the core merges and range-checks (domain validity). A
      // partial patch: pass through whichever known knobs are present and typed;
      // a present-but-wrong-typed field rejects the whole intent.
      if (typeof msg.settings !== 'object' || msg.settings === null) return null;
      const s = msg.settings as Record<string, unknown>;
      const settings: Partial<RoomSettings> = {};
      if ('roundDurationMs' in s) {
        if (typeof s.roundDurationMs !== 'number') return null;
        settings.roundDurationMs = s.roundDurationMs;
      }
      if ('countdownMs' in s) {
        if (typeof s.countdownMs !== 'number') return null;
        settings.countdownMs = s.countdownMs;
      }
      if ('difficulty' in s) {
        if (typeof s.difficulty !== 'string') return null;
        if (!(DIFFICULTIES as readonly string[]).includes(s.difficulty)) return null;
        settings.difficulty = s.difficulty as Difficulty;
      }
      if ('category' in s) {
        if (typeof s.category !== 'string') return null;
        if (!(CATEGORIES as readonly string[]).includes(s.category)) return null;
        settings.category = s.category as Category;
      }
      return { type: 'room/setSettings', settings };
    }
    case 'game/start':
      return { type: 'game/start' };
    case 'race/hop':
      return typeof msg.article === 'string' && msg.article.length > 0 && msg.article.length < 512
        ? { type: 'race/hop', article: msg.article }
        : null;
    case 'race/giveUp':
      return { type: 'race/giveUp' };
    case 'room/kick':
      return typeof msg.playerId === 'string'
        ? { type: 'room/kick', playerId: msg.playerId }
        : null;
    case 'game/playAgain':
      return { type: 'game/playAgain' };
    default:
      return null;
  }
}
