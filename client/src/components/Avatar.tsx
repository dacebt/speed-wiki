import { FACES, HATS, type PlayerCosmetics } from '@wikispeedrun/shared';
import './avatar.css';

// Portrait miniature: face glyph in an oval gilt frame, hat perched on top.

export function Avatar({
  cosmetics,
  size = 'md',
}: {
  cosmetics: PlayerCosmetics;
  size?: 'sm' | 'md' | 'lg';
}) {
  const face = FACES.find((f) => f.id === cosmetics.faceId) ?? FACES[0]!;
  const hat = HATS.find((h) => h.id === cosmetics.hatId);
  return (
    <span className={`avatar avatar--${size}`} role="img" aria-label={face.label}>
      <span className="avatar__face">{face.glyph}</span>
      {hat && hat.glyph !== '' && <span className="avatar__hat">{hat.glyph}</span>}
    </span>
  );
}
