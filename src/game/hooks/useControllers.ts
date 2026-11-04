import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputAction } from '../../../shared/types';
import { HAPTIC_PATTERNS, SCROLL_SPEED, controllerScrollPixels, initializePad, inputTargetIsEditable, keyboardAction, menuActionForInput, stepPad, type FeedbackKind, type MenuAction, type PadMemory } from '../input';
import { playFeedback, unlockAudio } from '../sound';

export interface ControllerStatus {
  index: number;
  id: string;
  seat: number | null;
  connected: boolean;
  mapping: string;
  buttons: number[];
  axis: number;
  verticalAxis: number;
  rightAxis: number;
  haptics: boolean;
}

export interface LastInput { seat: number; action: InputAction; source: 'keyboard' | 'gamepad'; at: number }
export interface ControllerOptions {
  enabled: boolean;
  seats: number[];
  onAction: (seat: number, action: InputAction) => void;
  onScroll?: (pixels: number) => void;
  menuOpen?: boolean;
  onMenuAction?: (action: MenuAction) => void;
  intensity: number;
  sound: boolean;
}

interface LegacyActuator { pulse?: (intensity: number, duration: number) => Promise<unknown> }
type EnhancedPad = Gamepad & { hapticActuators?: LegacyActuator[] };

function safePads(): Gamepad[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') return [];
  return Array.from(navigator.getGamepads()).filter((pad): pad is Gamepad => Boolean(pad?.connected));
}

export function useControllers(options: ControllerOptions) {
  const [controllers, setControllers] = useState<ControllerStatus[]>([]);
  const [supported, setSupported] = useState(() => typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function');
  const [lastInput, setLastInput] = useState<LastInput | null>(null);
  const settings = useRef(options);
  settings.current = options;
  const assignments = useRef(new Map<number, number | null>());
  const identities = useRef(new Map<number, string>());
  const memories = useRef(new Map<number, PadMemory>());

  const vibrate = useCallback((seat: number, kind: FeedbackKind) => {
    const intensity = Math.min(1, Math.max(0, settings.current.intensity));
    if (settings.current.sound) playFeedback(kind);
    if (!intensity) return;
    try {
      const pad = safePads().find(item => assignments.current.get(item.index) === seat) as EnhancedPad | undefined;
      if (!pad) return;
      const pattern = HAPTIC_PATTERNS[kind];
      if (typeof pad.vibrationActuator?.playEffect === 'function') {
        void pad.vibrationActuator.playEffect('dual-rumble', {
          startDelay: 0, duration: pattern.duration,
          strongMagnitude: pattern.strongMagnitude * intensity,
          weakMagnitude: pattern.weakMagnitude * intensity,
        }).catch(() => undefined);
      } else {
        const actuator = pad.hapticActuators?.find(item => typeof item.pulse === 'function');
        if (actuator?.pulse) void actuator.pulse(Math.max(pattern.strongMagnitude, pattern.weakMagnitude) * intensity, pattern.duration).catch(() => undefined);
      }
    } catch { /* OS/browser/controller combinations may decline haptics. */ }
  }, []);

  const assign = useCallback((index: number, seat: number | null) => {
    if (seat !== null && !settings.current.seats.includes(seat)) return;
    for (const [otherIndex, otherSeat] of assignments.current) {
      if (seat !== null && otherIndex !== index && otherSeat === seat) assignments.current.set(otherIndex, null);
    }
    assignments.current.set(index, seat);
    // Reassignment requires released controls before any new trades.
    try {
      const pad = safePads().find(item => item.index === index);
      if (pad) memories.current.set(index, initializePad(pad, Boolean(settings.current.menuOpen)));
    } catch { /* Detection will recover on the next poll. */ }
  }, []);

  useEffect(() => {
    let frame = 0;
    let lastRender = 0;
    let lastPoll = 0;
    let previousView = '';
    const pressedKeys = new Set<string>();
    const emit = (seat: number, action: InputAction, source: LastInput['source']) => {
      if (!settings.current.enabled || settings.current.menuOpen || !settings.current.seats.includes(seat) || document.visibilityState === 'hidden' || !document.hasFocus()) return;
      setLastInput({ seat, action, source, at: Date.now() });
      settings.current.onAction(seat, action);
    };
    const emitMenu = (action: MenuAction) => {
      if (!settings.current.menuOpen || document.visibilityState === 'hidden' || !document.hasFocus()) return;
      settings.current.onMenuAction?.(action);
    };
    const poll = (time: number) => {
      const elapsed = lastPoll ? Math.max(0, Math.min(50, time - lastPoll)) : 0;
      lastPoll = time;
      try {
        const pads = safePads().sort((left, right) => left.index - right.index);
        const menuOpen = Boolean(settings.current.menuOpen);
        const available: number[] = [...new Set(settings.current.seats)].filter(seat => seat === 0 || seat === 1).sort();
        const liveIndices = new Set(pads.map(pad => pad.index));
        for (const index of memories.current.keys()) {
          if (!liveIndices.has(index)) memories.current.delete(index);
        }
        const assignedSeats = new Set<number>();
        let scroll = 0;
        for (const pad of pads) {
          if (identities.current.get(pad.index) !== pad.id) {
            identities.current.set(pad.index, pad.id);
            assignments.current.delete(pad.index);
            memories.current.delete(pad.index);
          }
          const previousSeat = assignments.current.get(pad.index);
          if (previousSeat !== null && previousSeat !== undefined && !available.includes(previousSeat)) assignments.current.delete(pad.index);
          if (previousSeat !== null && previousSeat !== undefined && assignedSeats.has(previousSeat)) assignments.current.delete(pad.index);
          if (!assignments.current.has(pad.index)) {
            assignments.current.set(pad.index, available.find(seat => !assignedSeats.has(seat)) ?? null);
          }
          const currentSeat = assignments.current.get(pad.index);
          if (currentSeat !== null && currentSeat !== undefined) assignedSeats.add(currentSeat);
          if (currentSeat !== null && currentSeat !== undefined && pad.mapping === 'standard') scroll += controllerScrollPixels(pad, elapsed);
          if (previousSeat !== currentSeat) memories.current.delete(pad.index);
          const previous = memories.current.get(pad.index);
          if (!previous) memories.current.set(pad.index, initializePad(pad, menuOpen));
          else {
            const next = stepPad(previous, pad, menuOpen);
            memories.current.set(pad.index, next.memory);
            const seat = assignments.current.get(pad.index);
            if (seat !== null && seat !== undefined && pad.mapping === 'standard') {
              for (const action of next.actions) {
                if (menuOpen) {
                  const menuAction = menuActionForInput(action);
                  if (menuAction) emitMenu(menuAction);
                } else emit(seat, action, 'gamepad');
              }
            }
          }
        }
        // Browsing the page and long dialogs remains available outside a live round.
        // Shared-screen opposing sticks cancel; two pads cannot double the scroll speed.
        if (scroll && document.visibilityState !== 'hidden' && document.hasFocus() && !inputTargetIsEditable(document.activeElement)) {
          const limit = SCROLL_SPEED * elapsed / 1000;
          settings.current.onScroll?.(Math.max(-limit, Math.min(limit, scroll)));
        }
        if (time - lastRender > 100) {
          const view: ControllerStatus[] = pads.map(pad => ({
            index: pad.index, id: pad.id, seat: assignments.current.get(pad.index) ?? null,
            connected: pad.connected, mapping: pad.mapping,
            buttons: pad.buttons.map(button => Math.round(button.value * 100) / 100),
            axis: Math.round((pad.axes[0] ?? 0) * 100) / 100,
            verticalAxis: Math.round((pad.axes[1] ?? 0) * 100) / 100,
            rightAxis: Math.round((pad.axes[3] ?? 0) * 100) / 100,
            haptics: Boolean(pad.vibrationActuator || (pad as EnhancedPad).hapticActuators?.length),
          }));
          const serialized = JSON.stringify(view);
          if (serialized !== previousView) { setControllers(view); previousView = serialized; }
          lastRender = time;
        }
      } catch { setSupported(false); }
      frame = requestAnimationFrame(poll);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!settings.current.enabled || settings.current.menuOpen || event.repeat || event.metaKey || event.ctrlKey || event.altKey || inputTargetIsEditable(event.target)) return;
      // Preserve native activation of a focused button/link with Enter or Space.
      if ((event.code === 'Enter' || event.code === 'Space') && event.target instanceof Element && event.target.closest('button, a, [role="button"]')) return;
      const mapped = keyboardAction(event.code, settings.current.seats);
      if (!mapped || pressedKeys.has(event.code)) return;
      event.preventDefault();
      pressedKeys.add(event.code);
      if (settings.current.sound) unlockAudio();
      emit(mapped.seat, mapped.action, 'keyboard');
    };
    const keyUp = (event: KeyboardEvent) => { pressedKeys.delete(event.code); };
    const blur = () => {
      pressedKeys.clear();
      // On refocus, held hardware controls are sampled afresh rather than fired.
      memories.current.clear();
    };
    const pointerDown = () => { if (settings.current.sound) unlockAudio(); };
    window.addEventListener('keydown', keyDown);
    window.addEventListener('keyup', keyUp);
    window.addEventListener('blur', blur);
    window.addEventListener('pointerdown', pointerDown);
    frame = requestAnimationFrame(poll);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('keydown', keyDown);
      window.removeEventListener('keyup', keyUp);
      window.removeEventListener('blur', blur);
      window.removeEventListener('pointerdown', pointerDown);
    };
  }, []);

  return { controllers, supported, vibrate, assign, lastInput };
}
