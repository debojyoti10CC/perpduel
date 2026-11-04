import { useState } from 'react';
import { ArrowRight, Check, ExternalLink, LoaderCircle, Wallet } from 'lucide-react';
import { cancelEscrowRoom, connectMonadWallet, readEscrowBalance, readEscrowRoom, refundEscrowRoom, resolveEscrowRoom, withdrawEscrowCredit } from '../../hooks/monadWallet.js';
import { apiOrigin } from '../hooks/useDuel';

interface Props { code: string; contractAddress: string; roomId: string; voided: boolean }

export default function EscrowClaim({ code, contractAddress, roomId, voided }: Props) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [transactionHash, setTransactionHash] = useState('');
  const [complete, setComplete] = useState(false);

  const claim = async () => {
    setBusy(true); setError(''); setComplete(false);
    try {
      setStatus('Connect your Monad testnet wallet.');
      const wallet = await connectMonadWallet();
      let room = await readEscrowRoom(contractAddress, roomId);
      const isParticipant = [room.creator, room.opponent].some(address => address.toLowerCase() === wallet.address.toLowerCase());
      if (!isParticipant) throw new Error('Connect the wallet that funded your seat in this room.');
      if (room.status === 0) throw new Error('This room has no confirmed escrow deposit.');
      if (room.status === 1 && wallet.address.toLowerCase() === room.creator.toLowerCase()) {
        setStatus('Confirm cancellation of the unmatched room in your wallet.');
        const transaction = await cancelEscrowRoom(contractAddress, roomId);
        setTransactionHash(transaction.transactionHash);
      } else if ([1, 2].includes(room.status) && Date.now() / 1000 >= room.refundAfter) {
        setStatus('Confirm the expired-room refund in your wallet.');
        const transaction = await refundEscrowRoom(contractAddress, roomId);
        setTransactionHash(transaction.transactionHash);
      } else if (room.status === 2) {
        setStatus('Reading the signed match result…');
        const response = await fetch(`${apiOrigin}/api/rooms/${encodeURIComponent(code)}/result`, { credentials: 'same-origin' });
        const voucher = await response.json();
        if (!response.ok) throw new Error(voucher.error || 'The signed match result is not available yet.');
        setStatus('Confirm settlement in your wallet.');
        const transaction = await resolveEscrowRoom(contractAddress, voucher);
        setTransactionHash(transaction.transactionHash);
      }
      room = await readEscrowRoom(contractAddress, roomId);
      if (![3, 4].includes(room.status)) throw new Error('This room is not ready to withdraw.');
      const balance = await readEscrowBalance(contractAddress, wallet.address);
      if (balance.creditWei > 0n) {
        setStatus(`Confirm withdrawal of ${balance.credit} test MON in your wallet.`);
        const transaction = await withdrawEscrowCredit(contractAddress);
        setTransactionHash(transaction.transactionHash);
        setStatus(`${balance.credit} test MON withdrawn to your wallet.`);
      } else {
        setStatus('Room settled. This wallet has no remaining withdrawal.');
      }
      setComplete(true);
    } catch (cause) {
      const detail = cause as { code?: number | string; shortMessage?: string; message?: string };
      setError(detail.code === 4001 || detail.code === 'ACTION_REJECTED' ? 'Cancelled in your wallet. You can try again.' : detail.shortMessage || detail.message || 'Settlement could not complete. Please try again.');
      setStatus('');
    } finally { setBusy(false); }
  };

  return <section className="arena-claim" aria-label="Monad testnet settlement">
    <div><Wallet size={17}/><strong>{voided ? 'Return your test MON' : 'Settle your test MON stake'}</strong><span>MONAD TESTNET</span></div>
    <p>Settlement credits the winning wallet or refunds a voided round. Withdrawal is a separate wallet confirmation; testnet gas applies.</p>
    <button className="button button-primary" disabled={busy} onClick={claim}>{busy ? <LoaderCircle size={15} className="spin"/> : complete ? <Check size={15}/> : <Wallet size={15}/>} {busy ? 'Waiting for wallet…' : complete ? 'Check withdrawal' : voided ? 'Resolve & refund' : 'Resolve & withdraw'} {!busy && <ArrowRight size={15}/>}</button>
    {status && <p className="arena-claim-status" role="status">{status}</p>}
    {error && <p className="arena-claim-error" role="alert">{error}</p>}
    {transactionHash && <a className="arena-claim-receipt" href={`https://testnet.monadvision.com/tx/${transactionHash}`} target="_blank" rel="noreferrer">View confirmed transaction <ExternalLink size={12}/></a>}
  </section>;
}
