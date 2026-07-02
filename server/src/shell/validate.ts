import type { ClientIntent } from '@wikispeedrun/shared';

// Boundary validation: anything arriving over the wire is untrusted until it
// structurally matches a known intent. The core assumes shapes are valid;
// this is the only place that guarantee is established.

export function parseClientIntent(raw: unknown): ClientIntent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const msg = raw as Record<string, unknown>;

  switch (msg.type) {
    case 'room/create':
      return typeof msg.playerName === 'string'
        ? { type: 'room/create', playerName: msg.playerName }
        : null;
    case 'room/join':
      return typeof msg.code === 'string' && typeof msg.playerName === 'string'
        ? { type: 'room/join', code: msg.code, playerName: msg.playerName }
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
    case 'game/start':
      return typeof msg.hardMode === 'boolean'
        ? { type: 'game/start', hardMode: msg.hardMode }
        : null;
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
