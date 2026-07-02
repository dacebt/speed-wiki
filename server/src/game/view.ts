import type { RoomSync } from '@wikispeedrun/shared';
import type { CoreRoom } from './state.js';

/** The full-state sync broadcast to every client on any change. */
export function toRoomSync(room: CoreRoom): RoomSync {
  return {
    code: room.code,
    phase: room.phase,
    round: room.round,
    countdownEndsAt: room.countdownEndsAt,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      cosmetics: p.cosmetics,
      isHost: p.isHost,
      score: p.score,
      path: p.path,
      clicks: Math.max(0, p.path.length - 1),
      finishedRank: p.finishedRank,
      finishedAfterMs: p.finishedAfterMs,
      gaveUp: p.gaveUp,
    })),
  };
}
