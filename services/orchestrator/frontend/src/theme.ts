// One accent + monogram per specialist agent, assigned deterministically from its id
// so a new silo in config/agent-silos.ts gets a distinct, harmonious look with no
// frontend change. This isn't decoration: color-coding by agent tells the reader
// which specialist's rules (and which specialist's answer) they're looking at.

export interface AgentTheme {
  accent: string;
  tint: string;
  monogram: string;
}

const PALETTE: { accent: string; tint: string }[] = [
  { accent: '#2E6F5E', tint: '#E4F0EC' }, // teal-green
  { accent: '#7A3B49', tint: '#F3E7EA' }, // wine
  { accent: '#8C6A2E', tint: '#F1EBDD' }, // ochre
  { accent: '#5A4E8C', tint: '#EAE8F3' }, // violet
  { accent: '#3E6B7A', tint: '#E4EDEF' }, // slate-teal
  { accent: '#3F6B3A', tint: '#E6EEE3' }, // forest
];

export const ADMIN_THEME: AgentTheme = { accent: '#3D4A6B', tint: '#E7E9F0', monogram: 'AD' };

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function themeFor(agentId: string): AgentTheme {
  const { accent, tint } = PALETTE[hash(agentId) % PALETTE.length];
  return { accent, tint, monogram: agentId.slice(0, 2).toUpperCase() };
}
