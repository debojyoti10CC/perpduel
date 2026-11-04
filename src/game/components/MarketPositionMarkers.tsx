import { ArrowDown, ArrowUp } from 'lucide-react';
import type { Coin, Position } from '../../../shared/types';

type MarketPosition = Pick<Position, 'quantity'> & { seat: number };
export type PositionsByMarket = Partial<Record<Coin, MarketPosition[]>>;

const side = ({ quantity }: MarketPosition) => quantity > 0 ? 'long' : 'short';
const description = (position: MarketPosition) => `Player ${position.seat + 1}: open ${side(position)}`;

export function marketPositionLabel(label: string, positions: MarketPosition[]) {
  return [label, ...positions.map(description)].join('. ');
}

export default function MarketPositionMarkers({ positions }: { positions: MarketPosition[] }) {
  if (!positions.length) return null;

  return (
    <span className="market-position-markers" aria-hidden="true">
      {positions.map(position => {
        const Direction = position.quantity > 0 ? ArrowUp : ArrowDown;
        return (
          <span key={position.seat} className={`market-position-marker is-${side(position)}`} title={description(position)}>
            <Direction size={11} strokeWidth={2.5} />
            <span>P{position.seat + 1}</span>
          </span>
        );
      })}
    </span>
  );
}
