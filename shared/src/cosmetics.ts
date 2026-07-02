// Player avatars are composed from a face and a hat, picked in the lobby.
// Both sides need this catalog: the client to render the picker, the server
// to validate the choice.

export interface CosmeticOption {
  id: string;
  glyph: string;
  label: string;
}

export const FACES: readonly CosmeticOption[] = [
  { id: 'scholar', glyph: '🧐', label: 'The Scholar' },
  { id: 'grin', glyph: '😁', label: 'The Grinner' },
  { id: 'thinker', glyph: '🤔', label: 'The Thinker' },
  { id: 'owl', glyph: '🦉', label: 'The Owl' },
  { id: 'wizard', glyph: '🧙', label: 'The Sage' },
  { id: 'robot', glyph: '🤖', label: 'The Automaton' },
  { id: 'cat', glyph: '🐱', label: 'The Librarian’s Cat' },
  { id: 'skull', glyph: '💀', label: 'The Memento Mori' },
] as const;

export const HATS: readonly CosmeticOption[] = [
  { id: 'none', glyph: '', label: 'Bare-headed' },
  { id: 'grad', glyph: '🎓', label: 'Mortarboard' },
  { id: 'crown', glyph: '👑', label: 'Crown' },
  { id: 'tophat', glyph: '🎩', label: 'Top Hat' },
  { id: 'beret', glyph: '🧢', label: 'Cap' },
  { id: 'party', glyph: '🎉', label: 'Party' },
  { id: 'halo', glyph: '😇', label: 'Halo' },
  { id: 'candle', glyph: '🕯️', label: 'Candle' },
] as const;

export interface PlayerCosmetics {
  faceId: string;
  hatId: string;
}

export const DEFAULT_COSMETICS: PlayerCosmetics = { faceId: 'scholar', hatId: 'none' };

export function isValidCosmetics(c: PlayerCosmetics): boolean {
  return FACES.some((f) => f.id === c.faceId) && HATS.some((h) => h.id === c.hatId);
}
