import { Gamepad2, Keyboard, Radio, ShieldCheck } from 'lucide-react';
import type { Phase, Player } from '../../../shared/types';
import { money } from '../lib';
import Identicon from '../../components/Identicon';
import PlayerPnl from './PlayerPnl';

export default function PlayerCard({ player, seat, owns, controller, flash, phase, avatarSeed, elapsedMs }: { player: Player; seat: number; owns: boolean; controller: boolean; flash?: string; phase?: Phase; avatarSeed?: string; elapsedMs: number }) {
  const pnl = player.equity - 1000;
  return <section className={`player-card player-${seat}${flash ? ` flash-${flash}` : ''}`} aria-label={`Player ${seat + 1} account`}>
    <div className="player-card-top"><div className="player-identity"><Identicon seed={avatarSeed || player.name} className="player-avatar"/><div><div className="player-name">{player.name || 'Waiting for opponent'} {owns && <span className="you-badge">YOU</span>}</div><span className="player-status">{controller ? <Gamepad2 size={12}/> : <Keyboard size={12}/>} {player.connected ? (controller ? 'Controller' : 'Keyboard') : 'Offline'}</span></div></div><PlayerPnl pnl={pnl} elapsedMs={elapsedMs}/><span className={`status-tag${player.disabled ? ' danger' : player.ready || phase === 'active' ? ' ready' : ''}`}>{player.disabled ? 'RISK LIMIT' : phase === 'active' ? <><Radio size={10}/> LIVE</> : phase === 'finished' ? 'FINAL' : phase === 'void' ? 'VOID' : player.ready ? <><ShieldCheck size={11}/> READY</> : <><Radio size={10}/> STANDBY</>}</span></div>
    <div className="player-balance"><div><span className="label">PAPER EQUITY</span><strong>{money(player.equity)}</strong></div></div>
    <div className="player-metrics"><div><span>Available</span><b>{money(player.availableMargin)}</b></div><div><span>Max drawdown</span><b>{money(player.maxDrawdown)}</b></div><div><span>Duel score</span><b className={player.score >= 0 ? 'positive' : 'negative'}>{player.score >= 0 ? '+' : ''}{player.score.toFixed(2)}</b></div></div>
  </section>;
}
