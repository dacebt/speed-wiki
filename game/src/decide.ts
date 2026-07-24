import {
  isRoomSettingsInRange,
  isValidCosmetics,
  MAX_NAME_LENGTH,
  type ClientIntent,
  type ErrorCode,
} from '@wikispeedrun/shared';
import type { RoomEvent } from './events.js';
import { reduce } from './reduce.js';
import { sameArticle, type CoreRoom } from './state.js';

// All game rules live here. An intent either becomes a list of events or a
// rejection — nothing else. Time and randomness arrive as data on the intent.

/** Points by finish rank (1-based); finishers past the table get the floor. */
const POINTS_BY_RANK = [5, 4, 3, 2, 1] as const;
const POINTS_FLOOR = 1;

export type CoreIntent =
  | { kind: 'client'; playerId: string; at: number; intent: ClientIntent }
  | { kind: 'sys/countdownFinished'; startArticle: string; goalArticle: string; at: number }
  | { kind: 'sys/roundTimedOut'; at: number }
  // A dropped socket marks the player away (slot held); a lapsed grace window
  // finally removes them. The shell owns the grace timer — see registry.ts.
  | { kind: 'sys/playerAway'; playerId: string; at: number }
  | { kind: 'sys/playerLeft'; playerId: string; at: number }
  // Article selection for the pending round failed (e.g. random unreachable);
  // abort the countdown back to the lobby instead of starting a bad round.
  | { kind: 'sys/roundStartFailed'; at: number };

export type Decision =
  { ok: true; events: RoomEvent[] } | { ok: false; code: ErrorCode; message: string };

export function decide(room: CoreRoom, intent: CoreIntent): Decision {
  switch (intent.kind) {
    case 'client':
      return decideClient(room, intent.playerId, intent.at, intent.intent);
    case 'sys/countdownFinished': {
      if (room.phase !== 'countdown') return { ok: true, events: [] };
      const roundNumber = room.roundsPlayed + 1;
      return {
        ok: true,
        events: [
          {
            type: 'RoundStarted',
            roundNumber,
            startArticle: intent.startArticle,
            goalArticle: intent.goalArticle,
            startedAt: intent.at,
            deadline: intent.at + room.settings.roundDurationMs,
          },
        ],
      };
    }
    case 'sys/roundTimedOut': {
      if (room.phase !== 'racing') return { ok: true, events: [] };
      return { ok: true, events: [endRound(room, intent.at)] };
    }
    case 'sys/roundStartFailed': {
      if (room.phase !== 'countdown') return { ok: true, events: [] };
      return { ok: true, events: [{ type: 'CountdownAborted', at: intent.at }] };
    }
    case 'sys/playerAway': {
      // Hold the slot: mark away rather than removing, so a rejoin reattaches.
      // Benign in lobby/countdown/results; an away racer is handled by the
      // grace window (shell) and the mid-race rejoin capability.
      const player = room.players.find((p) => p.id === intent.playerId);
      if (!player || player.away) return { ok: true, events: [] };
      return {
        ok: true,
        events: [{ type: 'PlayerAway', playerId: intent.playerId, at: intent.at }],
      };
    }
    case 'sys/playerLeft': {
      // The grace window lapsed without a rejoin: a real departure.
      if (!room.players.some((p) => p.id === intent.playerId)) return { ok: true, events: [] };
      const events: RoomEvent[] = [
        { type: 'PlayerLeft', playerId: intent.playerId, at: intent.at },
      ];
      const after = reduce(room, events[0]!);
      if (after.phase === 'racing' && after.players.length > 0 && allDone(after)) {
        events.push(endRound(after, intent.at));
      }
      return { ok: true, events };
    }
  }
}

function decideClient(
  room: CoreRoom,
  playerId: string,
  at: number,
  intent: ClientIntent,
): Decision {
  const player = room.players.find((p) => p.id === playerId);

  switch (intent.type) {
    // room/create and room/join reach the core identically: a player entering
    // this room. The shell resolves the code and creates the room object.
    case 'room/create':
    case 'room/join': {
      // A create/join whose playerId is already in the room is a rejoin: the
      // slot is reattached in any phase (that is the whole point of a stable
      // id), never appended as a duplicate. A brand-new player stays phase-gated.
      if (player) {
        return { ok: true, events: [{ type: 'PlayerReconnected', playerId, at }] };
      }
      if (room.phase !== 'lobby' && room.phase !== 'results') {
        return reject('wrong-phase', 'A race is underway — try again between rounds.');
      }
      const name = intent.playerName.trim();
      if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
        return reject('invalid-name', `Names must be 1–${MAX_NAME_LENGTH} characters.`);
      }
      return { ok: true, events: [{ type: 'PlayerJoined', playerId, name, at }] };
    }

    case 'player/setCosmetics': {
      if (!player) return reject('not-in-room', 'You are not in this room.');
      if (!isValidCosmetics(intent.cosmetics)) {
        return reject('invalid-cosmetics', 'Unknown cosmetic choice.');
      }
      return {
        ok: true,
        events: [{ type: 'CosmeticsSet', playerId, cosmetics: intent.cosmetics, at }],
      };
    }

    case 'room/setSettings': {
      if (!player) return reject('not-in-room', 'You are not in this room.');
      if (!player.isHost) return reject('not-host', 'Only the host may change settings.');
      if (room.phase !== 'lobby') {
        return reject('wrong-phase', 'Settings can only be changed in the lobby.');
      }
      // Merge the patch onto the current settings, then range-check the result.
      // Rejecting out-of-range rather than clamping keeps a silent coercion from
      // hiding the boundary failure (standards §7). The event carries the full
      // merged object — the room always holds one complete RoomSettings.
      const merged = { ...room.settings, ...intent.settings };
      if (!isRoomSettingsInRange(merged)) {
        return reject('invalid-settings', 'Those settings are outside the allowed range.');
      }
      return { ok: true, events: [{ type: 'SettingsChanged', settings: merged, at }] };
    }

    case 'game/start': {
      if (!player) return reject('not-in-room', 'You are not in this room.');
      if (!player.isHost) return reject('not-host', 'Only the host may start the race.');
      if (room.phase !== 'lobby')
        return reject('wrong-phase', 'The race can only start from the lobby.');
      return {
        ok: true,
        events: [
          {
            type: 'CountdownStarted',
            endsAt: at + room.settings.countdownMs,
            difficulty: room.settings.difficulty,
            category: room.settings.category,
            at,
          },
        ],
      };
    }

    case 'race/hop': {
      if (!player) return reject('not-in-room', 'You are not in this room.');
      // A hop can arrive just after a round ends (fetch was in flight when the
      // timer struck); that is not a user error, just a stale intent.
      if (room.phase !== 'racing' || !room.round) return { ok: true, events: [] };
      if (player.finishedRank !== null || player.gaveUp) return { ok: true, events: [] };

      // Hop legality (was the article reachable from the previous page?) is a
      // deliberate no-op in v1 — see ARCHITECTURE.md standing decisions.
      const events: RoomEvent[] = [{ type: 'HopMade', playerId, article: intent.article, at }];
      if (sameArticle(intent.article, room.round.goalArticle)) {
        // Drawn from a monotonic per-round counter (not a max over currently
        // present players), so a finisher leaving the room cannot cause a
        // later finisher to reuse a rank.
        const rank = room.ranksAssigned + 1;
        events.push({
          type: 'PlayerFinished',
          playerId,
          rank,
          afterMs: at - room.round.startedAt,
          at,
        });
      }
      let after = room;
      for (const e of events) after = reduce(after, e);
      if (allDone(after)) events.push(endRound(after, at));
      return { ok: true, events };
    }

    case 'race/giveUp': {
      if (!player) return reject('not-in-room', 'You are not in this room.');
      if (room.phase !== 'racing') return { ok: true, events: [] };
      if (player.finishedRank !== null || player.gaveUp) return { ok: true, events: [] };
      const events: RoomEvent[] = [{ type: 'PlayerGaveUp', playerId, at }];
      const after = reduce(room, events[0]!);
      if (allDone(after)) events.push(endRound(after, at));
      return { ok: true, events };
    }

    case 'game/playAgain': {
      if (!player) return reject('not-in-room', 'You are not in this room.');
      if (!player.isHost) return reject('not-host', 'Only the host can start another round.');
      if (room.phase !== 'results') return reject('wrong-phase', 'The round is not over.');
      return { ok: true, events: [{ type: 'ReturnedToLobby', at }] };
    }

    case 'room/kick': {
      if (!player) return reject('not-in-room', 'You are not in this room.');
      if (!player.isHost) return reject('not-host', 'Only the host may remove players.');
      if (room.phase !== 'lobby') {
        return reject('wrong-phase', 'Players can only be removed from the lobby.');
      }
      // A valid target is another player in the room — this rejects both an
      // unknown id and the host trying to remove themselves.
      const target = room.players.find((p) => p.id === intent.playerId && p.id !== playerId);
      if (!target) return reject('not-in-room', 'No such player to remove.');
      return { ok: true, events: [{ type: 'PlayerKicked', playerId: target.id, at }] };
    }
  }
}

function allDone(room: CoreRoom): boolean {
  return room.players.every((p) => p.finishedRank !== null || p.gaveUp);
}

function endRound(room: CoreRoom, at: number): RoomEvent {
  return {
    type: 'RoundEnded',
    at,
    scores: room.players
      .filter((p) => p.finishedRank !== null)
      .map((p) => ({
        playerId: p.id,
        points: POINTS_BY_RANK[p.finishedRank! - 1] ?? POINTS_FLOOR,
      })),
  };
}

function reject(code: ErrorCode, message: string): Decision {
  return { ok: false, code, message };
}
