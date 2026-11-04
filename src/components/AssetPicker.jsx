import { useEffect, useId, useRef, useState } from 'react';
import './AssetPicker.css';

const ASSETS = [
  { value: 'MON', label: 'MON', name: 'Monad', subtitle: 'MON' },
  { value: 'SOL', label: 'SOL', name: 'Solana', subtitle: 'SOL' },
  { value: 'ETH', label: 'ETH', name: 'Ethereum', subtitle: 'ETH' },
];

export default function AssetPicker({ value, onChange, label = 'Deposit currency', renderToken }) {
  return <OptionPicker value={value} onChange={onChange} label={label} options={ASSETS} renderIcon={renderToken} />;
}

export function OptionPicker({ value, onChange, label, options, renderIcon, className = '' }) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const optionRefs = useRef([]);
  const menuId = useId();
  const selectedIndex = Math.max(0, options.findIndex(option => option.value === value));
  const selected = options[selectedIndex];

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = event => {
      if (!rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [open]);

  useEffect(() => {
    if (open) {
      optionRefs.current[activeIndex]?.focus();
      optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, activeIndex]);

  const closeAndFocus = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };
  const choose = index => {
    onChange(options[index].value);
    closeAndFocus();
  };
  const openMenu = index => {
    setActiveIndex(index);
    setOpen(true);
  };
  const handleTriggerKeyDown = event => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      if (open && ['Enter', ' '].includes(event.key)) closeAndFocus();
      else openMenu(selectedIndex);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    }
  };
  const handleMenuKeyDown = event => {
    let nextIndex;
    if (event.key === 'ArrowDown') nextIndex = (activeIndex + 1) % options.length;
    if (event.key === 'ArrowUp') nextIndex = (activeIndex - 1 + options.length) % options.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = options.length - 1;
    if (nextIndex !== undefined) {
      event.preventDefault();
      setActiveIndex(nextIndex);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      choose(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeAndFocus();
    } else if (event.key === 'Tab') {
      // Resume normal tab order at the trigger before removing the focused menu.
      triggerRef.current?.focus();
      setOpen(false);
    }
  };

  return <div className={`currency-picker ${className}`} ref={rootRef} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button ref={triggerRef} className="currency-picker-trigger" type="button" aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId} onKeyDown={handleTriggerKeyDown} onClick={() => open ? closeAndFocus() : openMenu(selectedIndex)}>
      {renderIcon?.(selected.value, 23)}
      <span>{selected.label}</span>
      <svg className="currency-picker-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {open && <div className="currency-picker-menu" id={menuId} role="listbox" aria-label={label} onKeyDown={handleMenuKeyDown}>
      {options.map((option, index) => <button key={option.value} ref={node => { optionRefs.current[index] = node; }} type="button" role="option" aria-selected={option.value === value} tabIndex={-1} className={`currency-picker-option${index === activeIndex ? ' is-active' : ''}${option.value === value ? ' is-selected' : ''}`} onFocus={() => setActiveIndex(index)} onClick={() => choose(index)}>
        {renderIcon?.(option.value, 32)}
        <span className="currency-picker-asset"><span className="currency-picker-name">{option.name}</span>{option.subtitle && <span className="currency-picker-symbol">{option.subtitle}</span>}</span>
        {option.value === value && <svg className="currency-picker-check" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6" /></svg>}
      </button>)}
    </div>}
  </div>;
}
