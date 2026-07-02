import type { PlayerCosmetics } from '@wikispeedrun/shared';

// Everything that can happen to a room. State is a pure fold over these.
// Timestamps are server-assigned and arrive as data on the event.

export type RoomEvent =
  | { type: 'PlayerJoined'; playerId: string; name: string; at: number }
  | { type: 'PlayerLeft'; playerId: string; at: number }
  | { type: 'CosmeticsSet'; playerId: string; cosmetics: PlayerCosmetics; at: number }
  | { type: 'CountdownStarted'; endsAt: number; hardMode: boolean; at: number }
  | {
      type: 'RoundStarted';
      roundNumber: number;
      startArticle: string;
      goalArticle: string;
      hardMode: boolean;
      startedAt: number;
      deadline: number;
    }
  | { type: 'HopMade'; playerId: string; article: string; at: number }
  | { type: 'PlayerFinished'; playerId: string; rank: number; afterMs: number; at: number }
  | { type: 'PlayerGaveUp'; playerId: string; at: number }
  | { type: 'RoundEnded'; scores: Array<{ playerId: string; points: number }>; at: number }
  | { type: 'ReturnedToLobby'; at: number };
