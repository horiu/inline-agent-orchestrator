// Helpers shared by the backends and the tools.

export class ToolError extends Error {}

export const iso = (sec) => (typeof sec === 'number' ? new Date(sec * 1000).toISOString() : null);
export const tail = (s, n) => (s.length > n ? '…' + s.slice(s.length - n) : s);

export function windowLabel(mins) {
  if (mins === 300) return '5h';
  if (mins === 10080) return 'weekly';
  if (typeof mins === 'number') return `${mins}min`;
  return 'unknown';
}
