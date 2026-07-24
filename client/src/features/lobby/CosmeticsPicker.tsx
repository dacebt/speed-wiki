import { FACES, HATS, type PlayerView } from '@wikispeedrun/shared';
import { useEffect, useRef } from 'react';
import { sendIntent } from '../../lib/transport';

export function CosmeticsPicker({ me }: { me: PlayerView }) {
  const pendingCosmetics = useRef<PlayerView['cosmetics'] | null>(null);

  useEffect(() => {
    const pending = pendingCosmetics.current;
    if (pending?.faceId === me.cosmetics.faceId && pending.hatId === me.cosmetics.hatId) {
      pendingCosmetics.current = null;
    }
  }, [me.cosmetics.faceId, me.cosmetics.hatId]);

  function pick(part: 'faceId' | 'hatId', id: string) {
    const cosmetics = {
      ...(pendingCosmetics.current ?? me.cosmetics),
      [part]: id,
    };
    pendingCosmetics.current = cosmetics;
    sendIntent({
      type: 'player/setCosmetics',
      cosmetics,
    });
  }

  return (
    <section className="panel lobby__cosmetics">
      <span className="label">Choose your portrait</span>
      <div className="lobby__cosmetic-row">
        {FACES.map((face) => (
          <button
            key={face.id}
            aria-label={face.label}
            title={face.label}
            className={`lobby__swatch ${me.cosmetics.faceId === face.id ? 'lobby__swatch--active' : ''}`}
            onClick={() => pick('faceId', face.id)}
          >
            {face.glyph}
          </button>
        ))}
      </div>
      <div className="lobby__cosmetic-row">
        {HATS.map((hat) => (
          <button
            key={hat.id}
            aria-label={hat.label}
            title={hat.label}
            className={`lobby__swatch ${me.cosmetics.hatId === hat.id ? 'lobby__swatch--active' : ''}`}
            onClick={() => pick('hatId', hat.id)}
          >
            {hat.glyph === '' ? '∅' : hat.glyph}
          </button>
        ))}
      </div>
    </section>
  );
}
