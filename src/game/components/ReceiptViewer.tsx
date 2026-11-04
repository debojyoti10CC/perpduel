import { useState } from 'react';
import { FileCheck2, LoaderCircle } from 'lucide-react';
import { apiOrigin } from '../hooks/useDuel';
import { shortHash } from '../lib';

interface Receipt { hash: string; blockNumber: number; status: number; gasUsed: string; events: { name: string; args: Record<string, string> }[] }
export default function ReceiptViewer({ hash }: { hash?: string }) {
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [status, setStatus] = useState('');
  const load = async () => {
    if (!hash) return;
    setStatus('loading');
    try {
      const response = await fetch(`${apiOrigin}/api/receipt/${hash}`);
      if (!response.ok) throw new Error('Receipt unavailable. Local receipts reset when the server stops.');
      const data = await response.json() as Receipt;
      setReceipt(data); setStatus('');
    } catch (error) { setStatus(error instanceof Error ? error.message : 'Receipt unavailable'); }
  };
  return <div className="receipt-viewer"><button className="button button-small" onClick={load} disabled={!hash || status === 'loading'}>{status === 'loading' ? <LoaderCircle size={14} className="spin"/> : <FileCheck2 size={14}/>} View receipt</button>{status && status !== 'loading' && <p className="fine-print">{status}</p>}{receipt && <div className="receipt-data"><div><span>TRANSACTION</span><b>{shortHash(receipt.hash)}</b></div><div><span>BLOCK</span><b>{receipt.blockNumber}</b></div><div><span>STATUS</span><b className={receipt.status === 1 ? 'positive' : 'negative'}>{receipt.status === 1 ? 'Confirmed' : 'Failed'}</b></div><div><span>GAS USED</span><b>{receipt.gasUsed}</b></div>{receipt.events.length > 0 && <p>Contract events: {receipt.events.map(event => event.name).join(' · ')}</p>}</div>}</div>;
}
