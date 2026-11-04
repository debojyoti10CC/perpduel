import type { InputAction } from '../../shared/types';

export const STICK_TRIGGER = 0.6;
export const STICK_CENTER = 0.25;
export const SCROLL_DEADZONE = 0.2;
export const SCROLL_SPEED = 650;
export type NavigationAction = 'previous' | 'next' | 'up' | 'down';
export type MenuAction = NavigationAction | 'confirm' | 'back';

export interface PadSnapshot {
  buttons: readonly (boolean | { pressed: boolean; value?: number })[];
  axes: readonly number[];
}

export interface PadMemory {
  buttons: boolean[];
  navigationArmed: boolean;
  menuOpen?: boolean;
}

const buttonIsDown = (button: PadSnapshot['buttons'][number] | undefined): boolean =>
  typeof button === 'boolean' ? button : Boolean(button?.pressed || (button?.value ?? 0) > 0.5);

function navigationNeutral(pad: PadSnapshot): boolean {
  return Math.abs(pad.axes[0] ?? 0) <= STICK_CENTER &&
    Math.abs(pad.axes[1] ?? 0) <= STICK_CENTER &&
    ![12, 13, 14, 15].some(index => buttonIsDown(pad.buttons[index]));
}

function navigationIntent(pad: PadSnapshot): { active: boolean; action: NavigationAction | null } {
  const x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0;
  const stickActive = Math.abs(x) >= STICK_TRIGGER || Math.abs(y) >= STICK_TRIGGER;
  const stickAction: NavigationAction | null = !stickActive ? null : Math.abs(x) >= Math.abs(y)
    ? x < 0 ? 'previous' : 'next'
    : y < 0 ? 'up' : 'down';
  const directions: [number, NavigationAction][] = [[12, 'up'], [13, 'down'], [14, 'previous'], [15, 'next']];
  const dpad = directions.filter(([index]) => buttonIsDown(pad.buttons[index]));
  if (dpad.length) {
    const action = dpad.length === 1 ? dpad[0][1] : null;
    return { active: true, action: stickActive && action !== stickAction ? null : action };
  }
  return { active: stickActive, action: stickAction };
}

/** Horizontal cycling preserves the original order; vertical movement follows the rendered grid. */
export function navigateMarket(index: number, direction: NavigationAction, count: number, columns: number): number {
  const length = Math.max(0, Math.floor(Number.isFinite(count) ? count : 0));
  if (!length) return 0;
  const current = ((Math.floor(Number.isFinite(index) ? index : 0) % length) + length) % length;
  if (direction === 'previous' || direction === 'next') return (current + (direction === 'next' ? 1 : length - 1)) % length;
  const width = Math.max(1, Math.min(length, Math.floor(Number.isFinite(columns) ? columns : 1)));
  const column = current % width;
  const cells = Array.from({ length: Math.ceil((length - column) / width) }, (_, row) => column + row * width);
  const row = cells.indexOf(current);
  return cells[(row + (direction === 'down' ? 1 : cells.length - 1)) % cells.length];
}

/** Continuous right-stick scrolling, bounded after a suspended/background animation frame. */
export function controllerScrollPixels(pad: PadSnapshot, elapsedMs: number): number {
  const raw = pad.axes[3] ?? 0;
  if (!Number.isFinite(raw) || Math.abs(raw) <= SCROLL_DEADZONE) return 0;
  const axis = Math.max(-1, Math.min(1, raw));
  const magnitude = (Math.abs(axis) - SCROLL_DEADZONE) / (1 - SCROLL_DEADZONE);
  const elapsed = Math.max(0, Math.min(50, Number.isFinite(elapsedMs) ? elapsedMs : 0));
  return Math.sign(axis) * magnitude * SCROLL_SPEED * elapsed / 1000;
}

/** Seed from the current hardware state: connecting while holding a button never trades. */
export function initializePad(pad: PadSnapshot, menuOpen?: boolean): PadMemory {
  return { buttons: pad.buttons.map(buttonIsDown), navigationArmed: navigationNeutral(pad), menuOpen };
}

/** Edge-triggered controls. A stick sweep through the opposite side is still one tilt. */
export function stepPad(previous: PadMemory, pad: PadSnapshot, menuOpen?: boolean): { memory: PadMemory; actions: InputAction[] } {
  // A held menu confirmation/back button must not become a long/close-half order
  // when its dialog closes. Seed from current hardware on either context change.
  if (menuOpen !== undefined && menuOpen !== previous.menuOpen) return { memory: initializePad(pad, menuOpen), actions: [] };
  const buttons = pad.buttons.map(buttonIsDown);
  const rising = (index: number) => Boolean(buttons[index] && !previous.buttons[index]);
  const actions: InputAction[] = [];
  let navigationArmed = previous.navigationArmed;
  if (navigationNeutral(pad)) navigationArmed = true;
  const navigation = navigationIntent(pad);
  if (navigationArmed && navigation.active) {
    // Ambiguous opposing inputs consume the tilt without moving a market.
    if (navigation.action) actions.push(navigation.action);
    navigationArmed = false;
  }
  const tradeButtons: [number, InputAction][] = [[0, 'long'], [2, 'short'], [1, 'half'], [3, 'close']];
  const trades = tradeButtons.filter(([index]) => rising(index));
  // Do not turn a simultaneous accidental face-button press into opposing fills.
  if (trades.length === 1) actions.push(trades[0][1]);
  if (rising(4) !== rising(5)) actions.push(rising(4) ? 'marginDown' : 'marginUp');
  if (rising(9)) actions.push('ready');
  return { memory: { buttons, navigationArmed, menuOpen: menuOpen ?? previous.menuOpen }, actions };
}

/** Only navigation, A and B have meaning in menus; trade-only buttons are ignored. */
export function menuActionForInput(action: InputAction): MenuAction | null {
  if (action === 'previous' || action === 'next' || action === 'up' || action === 'down') return action;
  if (action === 'long') return 'confirm';
  if (action === 'half') return 'back';
  return null;
}

export const PRIMARY_KEYS: Readonly<Record<string, InputAction>> = {
  KeyQ: 'previous', KeyE: 'next', KeyR: 'up', KeyF: 'down', KeyW: 'long', KeyS: 'short',
  KeyA: 'half', KeyD: 'close', KeyZ: 'marginDown', KeyC: 'marginUp', Space: 'ready',
};

export const SECONDARY_KEYS: Readonly<Record<string, InputAction>> = {
  ArrowLeft: 'previous', ArrowRight: 'next', ArrowUp: 'up', ArrowDown: 'down', KeyI: 'long', KeyK: 'short',
  KeyJ: 'half', KeyL: 'close', KeyU: 'marginDown', KeyO: 'marginUp', Enter: 'ready',
};

/** A single remote player can use either layout; two local players keep separate layouts. */
export function keyboardAction(code: string, seats: readonly number[]): { seat: number; action: InputAction } | null {
  const available = [...new Set(seats)].filter(seat => seat === 0 || seat === 1).sort();
  if (!available.length) return null;
  if (PRIMARY_KEYS[code]) return { seat: available[0], action: PRIMARY_KEYS[code] };
  if (SECONDARY_KEYS[code] && available.includes(1)) return { seat: 1, action: SECONDARY_KEYS[code] };
  return null;
}

export function inputTargetIsEditable(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}

export const KEYBOARD_LAYOUTS = [
  { navigate: 'Q / E · R / F', long: 'W', short: 'S', half: 'A', close: 'D', margin: 'Z / C', ready: 'Space' },
  { navigate: '← / → · ↑ / ↓', long: 'I', short: 'K', half: 'J', close: 'L', margin: 'U / O', ready: 'Enter' },
] as const;

export type FeedbackKind = 'select' | 'fill' | 'reject' | 'risk' | 'countdown' | 'result' | 'ready';
export const HAPTIC_PATTERNS: Record<FeedbackKind, { duration: number; strongMagnitude: number; weakMagnitude: number }> = {
  select: { duration: 35, strongMagnitude: 0.08, weakMagnitude: 0.2 },
  fill: { duration: 120, strongMagnitude: 0.42, weakMagnitude: 0.65 },
  reject: { duration: 210, strongMagnitude: 0.72, weakMagnitude: 0.12 },
  risk: { duration: 420, strongMagnitude: 0.85, weakMagnitude: 0.5 },
  countdown: { duration: 65, strongMagnitude: 0.25, weakMagnitude: 0.5 },
  result: { duration: 650, strongMagnitude: 0.55, weakMagnitude: 0.85 },
  ready: { duration: 80, strongMagnitude: 0.2, weakMagnitude: 0.4 },
};
