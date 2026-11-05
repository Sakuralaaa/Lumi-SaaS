import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useErrorToast } from '../../lib/notify';

/** GET a resource, expose data/loading/reload; errors are toasted. */
export function useLoad<T>(path: string | null, params?: Record<string, string | number | undefined | null>, initial?: T) {
  const [data, setData] = useState<T | undefined>(initial);
  const [loading, setLoading] = useState(!!path);
  const toast = useErrorToast();
  const key = JSON.stringify(params ?? {});

  const reload = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api.get<T>(path, JSON.parse(key)));
    } catch (e) {
      toast(e);
    } finally {
      setLoading(false);
    }
  }, [path, key, toast]);

  useEffect(() => { void reload(); }, [reload]);
  return { data, setData, loading, reload };
}

export const fen2yuan = (f: number) => `¥${(Number(f || 0) / 100).toFixed(2)}`;
