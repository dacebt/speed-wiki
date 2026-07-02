import type { RoomEvent } from './events.js';
import type { CorePlayer, CoreRoom } from './state.js';

// Pure fold: one event in, next state out. No validation here — decide.ts
// only emits events that are legal, and reduce applies them unconditionally.

export function reduce(room: CoreRoom, event: RoomEvent): CoreRoom {
  switch (event.type) {
    case 'PlayerJoined': {
      const player: CorePlayer = {
        id: event.playerId,
        name: event.name,
        cosmetics: { faceId: 'scholar', hatId: 'none' },
        isHost: room.players.length === 0,
        score: 0,
        roundPoints: 0,
        path: [],
        finishedRank: null,
        finishedAfterMs: null,
        gaveUp: false,
      };
      return { ...room, players: [...room.players, player] };
    }

    case 'PlayerLeft': {
      const remaining = room.players.filter((p) => p.id !== event.playerId);
      const hadHost = remaining.some((p) => p.isHost);
      const players =
        !hadHost && remaining.length > 0
          ? remaining.map((p, i) => (i === 0 ? { ...p, isHost: true } : p))
          : remaining;
      return { ...room, players };
    }

    case 'CosmeticsSet':
      return updatePlayer(room, event.playerId, (p) => ({ ...p, cosmetics: event.cosmetics }));

    case 'CountdownStarted':
      return {
        ...room,
        phase: 'countdown',
        countdownEndsAt: event.endsAt,
        pendingHardMode: event.hardMode,
      };

    case 'RoundStarted':
      return {
        ...room,
        phase: 'racing',
        countdownEndsAt: null,
        round: {
          roundNumber: event.roundNumber,
          startArticle: event.startArticle,
          goalArticle: event.goalArticle,
          hardMode: event.hardMode,
          startedAt: event.startedAt,
          deadline: event.deadline,
        },
        players: room.players.map((p) => ({
          ...p,
          path: [event.startArticle],
          finishedRank: null,
          finishedAfterMs: null,
          gaveUp: false,
          roundPoints: 0,
        })),
      };

    case 'HopMade':
      return updatePlayer(room, event.playerId, (p) => ({
        ...p,
        path: [...p.path, event.article],
      }));

    case 'PlayerFinished':
      return updatePlayer(room, event.playerId, (p) => ({
        ...p,
        finishedRank: event.rank,
        finishedAfterMs: event.afterMs,
      }));

    case 'PlayerGaveUp':
      return updatePlayer(room, event.playerId, (p) => ({ ...p, gaveUp: true }));

    case 'RoundEnded': {
      const points = new Map(event.scores.map((s) => [s.playerId, s.points]));
      return {
        ...room,
        phase: 'results',
        roundsPlayed: room.roundsPlayed + 1,
        players: room.players.map((p) => {
          const earned = points.get(p.id) ?? 0;
          return { ...p, score: p.score + earned, roundPoints: earned };
        }),
      };
    }

    case 'ReturnedToLobby':
      return { ...room, phase: 'lobby', round: null, countdownEndsAt: null };
  }
}

function updatePlayer(
  room: CoreRoom,
  playerId: string,
  fn: (p: CorePlayer) => CorePlayer,
): CoreRoom {
  return { ...room, players: room.players.map((p) => (p.id === playerId ? fn(p) : p)) };
}
