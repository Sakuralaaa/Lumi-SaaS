/** Reference-image trimming for models that accept fewer images than the job has. */
import { PRODUCT_ROLES } from './prompt.js';

/** Lower = more important. Products are what we sell; the model photo is next; a style reference is the first to go. */
export function refPriority(role: string): number {
  if (role === 'base') return -1; // the photo being edited is never dropped
  if (PRODUCT_ROLES.includes(role)) return 0;
  if (role === 'model') return 1;
  if (role === 'clone') return 2;
  if (role === 'style') return 3;
  return 2;
}

/**
 * Keeps at most `max` references by priority product > model > style (stable by original position),
 * returned in their original order so image numbering stays natural.
 */
export function trimRefs<T extends { role: string }>(refs: T[], max: number): { kept: T[]; dropped: T[]; droppedStyle: boolean } {
  if (refs.length <= max) return { kept: [...refs], dropped: [], droppedStyle: false };
  const order = refs.map((r, i) => ({ r, i })).sort((a, b) => refPriority(a.r.role) - refPriority(b.r.role) || a.i - b.i);
  const keep = new Set(order.slice(0, Math.max(0, max)).map((x) => x.i));
  const kept = refs.filter((_, i) => keep.has(i));
  const dropped = refs.filter((_, i) => !keep.has(i));
  return { kept, dropped, droppedStyle: dropped.some((d) => d.role === 'style') };
}
