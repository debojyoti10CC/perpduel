import { CheckCircle2, ShieldCheck } from 'lucide-react';
import type { LedgerInfo } from '../../../shared/types';
import Modal from './Modal';

export default function NetworkStatus({ open, ledger, onClose, stakeContract }: { open: boolean; ledger: LedgerInfo | null; onClose: () => void; stakeContract?: string }) {
  if (!open) return null;
  const onMonad = ledger?.mode === 'monad';
  return <Modal title="Network" onClose={onClose}>
    <div className="ledger-network"><ShieldCheck size={24}/><div><h3>{onMonad ? ledger.chainId === 10143 ? 'Monad testnet' : 'Monad' : 'Paper ledger'}</h3><p>{onMonad ? `Chain ${ledger.chainId} · connected` : ledger?.mode === 'paper' ? 'Simulated orders execute on the game server.' : 'Local contract for paper accounts.'}</p></div></div>
    <div className="paper-explanation"><p><CheckCircle2 size={16}/><span>Each player gets <strong>$1,000 in virtual funds</strong>. Trading orders do not move tokens.</span></p><p><CheckCircle2 size={16}/><span>Funded testnet stakes use a separate player wallet and escrow.</span></p></div>
    {stakeContract && <dl className="ledger-details"><dt>Stake network</dt><dd>Monad testnet · 10143</dd><dt>Room escrow</dt><dd>{stakeContract}</dd></dl>}
    {onMonad && <dl className="ledger-details"><dt>Contract</dt><dd>{ledger.contractAddress}</dd><dt>Chain ID</dt><dd>{ledger.chainId}</dd></dl>}
    <div className="modal-actions"><span/><button className="button button-primary" onClick={onClose}>Done</button></div>
  </Modal>;
}
