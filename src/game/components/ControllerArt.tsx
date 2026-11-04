export default function ControllerArt({ active = [], axis = 0, verticalAxis = 0, rightAxis = 0 }: { active?: number[]; axis?: number; verticalAxis?: number; rightAxis?: number }) {
  const color = (button: number, base: string) => active[button] > 0.5 ? base : '#252c38';
  return <svg className="controller-art" viewBox="0 0 300 195" fill="none" aria-label="Controller input visualization">
    <path d="M71 43c17-11 40-8 54 0h50c14-8 37-11 54 0 23 16 47 88 40 116-6 29-24 29-43 7l-29-29h-94l-29 29c-19 22-37 22-43-7C24 131 48 59 71 43Z" fill="#292237" stroke="#827092" strokeWidth="2"/>
    <path d="M63 42c15-16 32-17 49-9" stroke={active[6] > 0.5 ? '#55d6a7' : '#566078'} strokeWidth="7" strokeLinecap="round"/>
    <path d="M188 33c17-8 34-7 49 9" stroke={active[7] > 0.5 ? '#ff91ad' : '#566078'} strokeWidth="7" strokeLinecap="round"/>
    <text x="87" y="22" fill="#a9e9d3" fontSize="15" fontWeight="700" textAnchor="middle">LT</text>
    <text x="213" y="22" fill="#ffbacb" fontSize="15" fontWeight="700" textAnchor="middle">RT</text>
    <circle cx="92" cy="79" r="24" fill="#0e1218" stroke="#414a5a"/>
    <circle cx={92 + axis * 8} cy={79 + verticalAxis * 8} r="16" fill="#303b4f" stroke="#667b9d"/>
    <circle cx="185" cy="121" r="22" fill="#10141a" stroke="#343e4e"/><circle cx="185" cy={121 + rightAxis * 8} r="14" fill="#2e3746"/>
    <path d="M106 106v13H93v13h13v13h13v-13h13v-13h-13v-13Z" fill="#3c4656" stroke="#576278"/>
    <circle cx="221" cy="94" r="10" fill={color(0, '#55d6a7')} stroke="#54b694"/><text x="221" y="98" textAnchor="middle" fill="#c6f6e4" fontSize="11" fontFamily="sans-serif">A</text>
    <circle cx="242" cy="73" r="10" fill={color(1, '#e36a7b')} stroke="#bd6070"/><text x="242" y="77" textAnchor="middle" fill="#f8c6d0" fontSize="11" fontFamily="sans-serif">B</text>
    <circle cx="200" cy="73" r="10" fill={color(2, '#538bff')} stroke="#5381c7"/><text x="200" y="77" textAnchor="middle" fill="#c4d9ff" fontSize="11" fontFamily="sans-serif">X</text>
    <circle cx="221" cy="52" r="10" fill={color(3, '#e9c164')} stroke="#a08d58"/><text x="221" y="56" textAnchor="middle" fill="#f7e6b8" fontSize="11" fontFamily="sans-serif">Y</text>
    <circle cx="134" cy="73" r="5" fill="#455268"/><circle cx="161" cy="73" r="5" fill={color(9, '#ffffff')}/><path d="m159 70 5 3-5 3" stroke="#a8b5cc" strokeWidth="1"/>
    <path d="m144 48 6 6 6-6" stroke="#7897cb" strokeWidth="2"/>
  </svg>;
}
