import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controllerScrollPixels, initializePad, keyboardAction, menuActionForInput, navigateMarket, stepPad, type PadSnapshot } from '../src/game/input';

const pad = (axis = 0, pressed: number[] = [], verticalAxis = 0, rightAxis = 0): PadSnapshot => ({
  axes: [axis, verticalAxis, 0, rightAxis], buttons: Array.from({ length: 17 }, (_, index) => pressed.includes(index)),
});

test('one stick tilt moves once and must return to center even after reversing direction', () => {
  let memory = initializePad(pad());
  let step = stepPad(memory, pad(0.8));
  assert.deepEqual(step.actions, ['next']); memory = step.memory;
  step = stepPad(memory, pad(0.9)); assert.deepEqual(step.actions, []); memory = step.memory;
  step = stepPad(memory, pad(-0.9)); assert.deepEqual(step.actions, []); memory = step.memory;
  step = stepPad(memory, pad(0.4)); assert.deepEqual(step.actions, []); memory = step.memory;
  step = stepPad(memory, pad(0.1)); assert.deepEqual(step.actions, []); memory = step.memory;
  step = stepPad(memory, pad(-0.9)); assert.deepEqual(step.actions, ['previous']);
});

test('a held trade button never repeats and must release before firing again', () => {
  let step = stepPad(initializePad(pad()), pad(0, [4]));
  assert.deepEqual(step.actions, ['long']);
  step = stepPad(step.memory, pad(0, [4])); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad()); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad(0, [4])); assert.deepEqual(step.actions, ['long']);
});

test('connecting while holding controls does not trade or switch markets', () => {
  let step = stepPad(initializePad(pad(1, [4, 5, 9])), pad(1, [4, 5, 9]));
  assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad());
  step = stepPad(step.memory, pad(1, [4]));
  assert.deepEqual(step.actions, ['next', 'long']);
});

test('standard button map uses LB long, RB short, B half, Y close, A/X margin, Start ready', () => {
  for (const [button, action] of [[4, 'long'], [5, 'short'], [1, 'half'], [3, 'close'], [0, 'marginDown'], [2, 'marginUp'], [9, 'ready']] as const) {
    assert.deepEqual(stepPad(initializePad(pad()), pad(0, [button])).actions, [action]);
  }
});

test('D-pad uses the same navigation latch and cannot repeat until released', () => {
  let step = stepPad(initializePad(pad()), pad(0, [14]));
  assert.deepEqual(step.actions, ['previous']);
  step = stepPad(step.memory, pad(0, [14])); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad(0, [15])); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad());
  step = stepPad(step.memory, pad(0, [15])); assert.deepEqual(step.actions, ['next']);
});

test('opposing navigation, face buttons, and shoulders do not emit conflicting actions', () => {
  assert.deepEqual(stepPad(initializePad(pad()), pad(0, [14, 15, 0, 2, 4, 5])).actions, []);
});

test('stick drift inside the threshold does not switch markets', () => {
  assert.deepEqual(stepPad(initializePad(pad()), pad(0.59)).actions, []);
  assert.deepEqual(stepPad(initializePad(pad()), pad(-0.59)).actions, []);
});

test('a sole remote second seat receives primary keyboard controls', () => {
  assert.deepEqual(keyboardAction('KeyW', [1]), { seat: 1, action: 'long' });
  assert.deepEqual(keyboardAction('Space', [1]), { seat: 1, action: 'ready' });
  assert.deepEqual(keyboardAction('KeyI', [1]), { seat: 1, action: 'long' });
});

test('local keyboard layouts do not cross seats', () => {
  assert.deepEqual(keyboardAction('KeyW', [0, 1]), { seat: 0, action: 'long' });
  assert.deepEqual(keyboardAction('KeyI', [0, 1]), { seat: 1, action: 'long' });
  assert.equal(keyboardAction('KeyI', [0]), null);
  assert.equal(keyboardAction('KeyW', []), null);
  assert.equal(keyboardAction('F5', [0, 1]), null);
});

test('left stick and D-pad support all four directions', () => {
  for (const [snapshot, expected] of [
    [pad(-.9), 'previous'], [pad(.9), 'next'], [pad(0, [], -.9), 'up'], [pad(0, [], .9), 'down'],
    [pad(0, [12]), 'up'], [pad(0, [13]), 'down'], [pad(0, [14]), 'previous'], [pad(0, [15]), 'next'],
  ] as const) assert.deepEqual(stepPad(initializePad(pad()), snapshot).actions, [expected]);
});

test('vertical navigation cannot rearm until both stick axes and every D-pad direction are centered', () => {
  let step = stepPad(initializePad(pad()), pad(0, [], .9));
  assert.deepEqual(step.actions, ['down']);
  step = stepPad(step.memory, pad(.9, [], .9)); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad(.1, [], .7)); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad(0, [12])); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad()); assert.deepEqual(step.actions, []);
  step = stepPad(step.memory, pad(0, [], -.9)); assert.deepEqual(step.actions, ['up']);
});

test('connecting with the vertical stick or D-pad held requires release before navigating', () => {
  for (const held of [pad(0, [], -.9), pad(0, [13])]) {
    let step = stepPad(initializePad(held), held);
    assert.deepEqual(step.actions, []);
    step = stepPad(step.memory, pad());
    step = stepPad(step.memory, held);
    assert.equal(step.actions.length, 1);
  }
});

test('stick diagonals and adjacent D-pad buttons each produce one diagonal move', () => {
  const center = initializePad(pad());
  for (const [x, y, buttons, direction] of [
    [-.5, -.5, [12, 14], 'up-left'],
    [ .5, -.5, [12, 15], 'up-right'],
    [-.5,  .5, [13, 14], 'down-left'],
    [ .5,  .5, [13, 15], 'down-right'],
  ] as const) {
    for (const input of [pad(x, [], y), pad(0, [...buttons])]) {
      const step = stepPad(center, input);
      assert.deepEqual(step.actions, [direction]);
      assert.deepEqual(stepPad(step.memory, input).actions, []);
    }
  }
  assert.deepEqual(stepPad(center, pad(.8, [], .2)).actions, ['next']);
  assert.deepEqual(stepPad(center, pad(.3, [], .3)).actions, []);
  assert.deepEqual(stepPad(center, pad(0, [12, 13])).actions, []);
  assert.deepEqual(stepPad(center, pad(.9, [14])).actions, []);
  const menu = initializePad(pad(), true);
  assert.deepEqual(stepPad(menu, pad(.7, [], .9), true).actions, ['down']);
  assert.deepEqual(stepPad(menu, pad(0, [13, 15]), true).actions, []);
});

test('diagonal moves advance both grid axes and wrap at the edges', () => {
  assert.equal(navigateMarket(1, 'down-left', 6, 3), 3);
  assert.equal(navigateMarket(1, 'down-right', 6, 3), 5);
  assert.equal(navigateMarket(4, 'up-left', 6, 3), 0);
  assert.equal(navigateMarket(4, 'up-right', 6, 3), 2);
  assert.equal(navigateMarket(5, 'down-right', 6, 3), 0);
  assert.equal(navigateMarket(0, 'up-left', 6, 3), 5);
  assert.equal(navigateMarket(0, 'down-right', 6, 2), 3);
  assert.equal(navigateMarket(1, 'down-right', 6, 1), 2);
  assert.equal(navigateMarket(1, 'down-right', 5, 3), 1);
});

test('grid navigation follows desktop and mobile columns while preserving horizontal wrap', () => {
  assert.equal(navigateMarket(0, 'down', 6, 3), 3);
  assert.equal(navigateMarket(4, 'up', 6, 3), 1);
  assert.equal(navigateMarket(0, 'up', 6, 3), 3);
  assert.equal(navigateMarket(5, 'down', 6, 3), 2);
  assert.equal(navigateMarket(0, 'down', 6, 2), 2);
  assert.equal(navigateMarket(2, 'down', 6, 2), 4);
  assert.equal(navigateMarket(0, 'up', 6, 2), 4);
  assert.equal(navigateMarket(5, 'next', 6, 3), 0);
  assert.equal(navigateMarket(0, 'previous', 6, 3), 5);
});

test('partial grid rows never select a nonexistent market or change columns vertically', () => {
  assert.equal(navigateMarket(2, 'down', 5, 3), 2);
  assert.equal(navigateMarket(4, 'up', 5, 3), 1);
  for (let count = 1; count <= 7; count++) for (let columns = 1; columns <= count; columns++) {
    for (let index = 0; index < count; index++) {
      const next = navigateMarket(index, 'down', count, columns);
      assert.ok(next >= 0 && next < count);
      assert.equal(next % columns, index % columns);
      assert.equal(navigateMarket(next, 'up', count, columns), index);
    }
  }
});

test('right-stick scrolling is continuous, frame-rate independent, deadzoned and bounded after a stall', () => {
  assert.equal(controllerScrollPixels(pad(0, [], 0, .2), 16), 0);
  assert.equal(controllerScrollPixels(pad(0, [], 0, -.1), 16), 0);
  const forward = pad(0, [], 0, 1), backward = pad(0, [], 0, -1);
  assert.ok(Math.abs(controllerScrollPixels(forward, 16) * 2 - controllerScrollPixels(forward, 32)) < 1e-9);
  assert.ok(controllerScrollPixels(forward, 16) > 0);
  assert.ok(controllerScrollPixels(backward, 16) < 0);
  assert.equal(controllerScrollPixels(forward, 10_000), 32.5);
  assert.equal(controllerScrollPixels(forward, -10), 0);
});

test('vertical keyboard controls stay separate from trading and respect remote seat ownership', () => {
  assert.deepEqual(keyboardAction('KeyR', [0, 1]), { seat: 0, action: 'up' });
  assert.deepEqual(keyboardAction('KeyF', [0, 1]), { seat: 0, action: 'down' });
  assert.deepEqual(keyboardAction('ArrowUp', [0, 1]), { seat: 1, action: 'up' });
  assert.deepEqual(keyboardAction('ArrowDown', [0, 1]), { seat: 1, action: 'down' });
  assert.deepEqual(keyboardAction('KeyF', [1]), { seat: 1, action: 'down' });
  assert.deepEqual(keyboardAction('KeyW', [0, 1]), { seat: 0, action: 'long' });
  assert.deepEqual(keyboardAction('KeyS', [0, 1]), { seat: 0, action: 'short' });
});

test('menu controls map A to confirm and B to back while ignoring trade-only controls', () => {
  for (const [button, expected] of [[0, 'confirm'], [1, 'back']] as const) {
    const frame = stepPad(initializePad(pad(), true), pad(0, [button]), true);
    assert.deepEqual(frame.actions.map(menuActionForInput).filter(Boolean), [expected]);
  }
  for (const button of [2, 3, 4, 5, 9]) {
    const frame = stepPad(initializePad(pad(), true), pad(0, [button]), true);
    assert.deepEqual(frame.actions.map(menuActionForInput).filter(Boolean), []);
  }
});

test('all four menu directions use the same stick and D-pad semantics', () => {
  for (const [snapshot, direction] of [[pad(-1), 'previous'], [pad(1), 'next'], [pad(0, [], -1), 'up'], [pad(0, [13]), 'down']] as const) {
    const frame = stepPad(initializePad(pad(), true), snapshot, true);
    assert.deepEqual(frame.actions.map(menuActionForInput), [direction]);
  }
});

test('held A and B cannot activate a new menu or leak a trade when the dialog closes', () => {
  for (const button of [0, 1]) {
    const held = pad(0, [button]);
    let frame = stepPad(initializePad(pad(), false), held, false);
    assert.equal(frame.actions.length, 1);
    frame = stepPad(frame.memory, held, true); assert.deepEqual(frame.actions, []);
    frame = stepPad(frame.memory, held, true); assert.deepEqual(frame.actions, []);
    frame = stepPad(frame.memory, pad(), true);
    frame = stepPad(frame.memory, held, true);
    assert.deepEqual(frame.actions.map(menuActionForInput), [button === 0 ? 'confirm' : 'back']);
    frame = stepPad(frame.memory, held, false); assert.deepEqual(frame.actions, []);
    frame = stepPad(frame.memory, held, false); assert.deepEqual(frame.actions, []);
    frame = stepPad(frame.memory, pad(), false);
    frame = stepPad(frame.memory, held, false);
    assert.deepEqual(frame.actions, [button === 0 ? 'marginDown' : 'half']);
  }
});

test('a stick held across a menu transition must recenter before moving focus or a market', () => {
  let frame = stepPad(initializePad(pad(), false), pad(1), false);
  assert.deepEqual(frame.actions, ['next']);
  frame = stepPad(frame.memory, pad(1), true); assert.deepEqual(frame.actions, []);
  frame = stepPad(frame.memory, pad(0, [], 1), true); assert.deepEqual(frame.actions, []);
  frame = stepPad(frame.memory, pad(), true);
  frame = stepPad(frame.memory, pad(0, [], 1), true); assert.deepEqual(frame.actions, ['down']);
  frame = stepPad(frame.memory, pad(0, [], 1), false); assert.deepEqual(frame.actions, []);
  frame = stepPad(frame.memory, pad(), false);
  frame = stepPad(frame.memory, pad(0, [], -1), false); assert.deepEqual(frame.actions, ['up']);
});
