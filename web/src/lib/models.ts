import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { Portrait, PortraitOptions } from '../api/types';

/** The user's model library (both sources). Signed URLs expire, so it refreshes every 10 min. */
export function useModelLibrary(enabled = true) {
  const [list, setList] = useState<Portrait[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<unknown>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.get<Portrait[]>('/api/models-library');
      setList(Array.isArray(r) ? r : []);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const t = window.setInterval(() => { void reload(); }, 10 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [enabled, reload]);

  const upsert = useCallback((p: Portrait) => setList((xs) => [p, ...xs.filter((x) => x.id !== p.id)]), []);
  const patch = useCallback((id: string, v: Partial<Portrait>) => setList((xs) => xs.map((x) => (x.id === id ? { ...x, ...v } : x))), []);
  const drop = useCallback((id: string) => setList((xs) => xs.filter((x) => x.id !== id)), []);

  return { list, loading, error, reload, upsert, patch, drop };
}

let optionsCache: Promise<PortraitOptions> | null = null;
export function loadPortraitOptions(): Promise<PortraitOptions> {
  if (!optionsCache) optionsCache = api.get<PortraitOptions>('/api/models-library/options').catch((e) => { optionsCache = null; throw e; });
  return optionsCache;
}
/** Prices can change; call before showing the cost so the modal shows the current value. */
export function invalidatePortraitOptions() { optionsCache = null; }

/** Display order of the attribute groups in the AI 模特 builder. */
export const ATTR_ORDER = ['gender', 'age_range', 'style', 'hair', 'look', 'body'];
