import type { FeedbackKind } from './input';

let context: AudioContext | undefined;

export function unlockAudio(): void {
  try {
    context ??= new AudioContext();
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
  } catch { /* Audio is an optional enhancement. */ }
}

export function playFeedback(kind: FeedbackKind): void {
  if (!context || context.state !== 'running') return;
  const notes: Record<FeedbackKind, number[]> = {
    select: [460], fill: [660, 880], reject: [180, 130], risk: [220, 150, 220],
    countdown: [520], result: [523, 659, 784], ready: [600, 760],
  };
  const audio = context;
  notes[kind].forEach((frequency, index) => {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const start = audio.currentTime + index * 0.09;
    oscillator.type = 'sine';
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(0.035, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(start);
    oscillator.stop(start + 0.1);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
  });
}
