import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export default function Modal({ title, subtitle, onClose, wide = false, className, headingIcon, children }: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  wide?: boolean;
  className?: string;
  headingIcon?: ReactNode;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.querySelector<HTMLButtonElement>('.modal-close')?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); }
      if (event.key !== 'Tab') return;
      const focusable = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href], [tabindex="0"]');
      if (!focusable?.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.body.style.overflow = oldOverflow; document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={`modal${wide ? ' modal-wide' : ''}${className ? ` ${className}` : ''}`} ref={panel} role="dialog" aria-modal="true" aria-labelledby="dialog-title">
      <header className="modal-header">
        <div>
          <h2 id="dialog-title">{headingIcon}{title}</h2>
          {subtitle && <p>{subtitle}</p>}
          <div className="controller-dialog-hint">D-pad: move · A: choose · B: back</div>
        </div>
        <button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}><X size={19}/></button>
      </header>
      {children}
    </div>
  </div>;
}
