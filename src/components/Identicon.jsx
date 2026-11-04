function hashSeed(value) {
  let hash = 2166136261;
  for (const character of String(value || 'perpduel').toLowerCase()) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0 || 0x9e3779b9;
}

function randomFrom(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export default function Identicon({ seed, className = '' }) {
  const stableSeed = String(seed || 'perpduel');
  const random = randomFrom(hashSeed(stableSeed));
  const hue = hashSeed(stableSeed) % 360;
  const background = `hsl(${hue} 31% 14%)`;
  const colors = [`hsl(${hue} 72% 69%)`, `hsl(${(hue + 38) % 360} 70% 73%)`, `hsl(${(hue + 326) % 360} 66% 64%)`];
  const tiles = [];

  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 3; x += 1) {
      if (random() > 0.44 || (x === 1 && y === 2)) {
        const color = colors[Math.floor(random() * colors.length)];
        tiles.push({ x, y, color }, ...(x < 2 ? [{ x: 4 - x, y, color }] : []));
      }
    }
  }

  return <span className={`avatar identicon ${className}`} aria-hidden="true">
    <svg viewBox="0 0 40 40" role="presentation" focusable="false">
      <rect width="40" height="40" rx="20" fill={background} />
      {tiles.map(({ x, y, color }, index) => <rect key={`${x}-${y}-${index}`} x={x * 8 + 1.4} y={y * 8 + 1.4} width="5.2" height="5.2" rx="1.3" fill={color} />)}
      <circle cx="20" cy="20" r="19.3" fill="none" stroke="white" strokeOpacity=".1" strokeWidth="1.2" />
    </svg>
  </span>;
}
