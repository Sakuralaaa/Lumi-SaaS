import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, onMustChangePassword } from '../api/client';
import type { Me } from '../api/types';

interface Ctx {
  user: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  setCredits: (n: number) => void;
  logout: () => Promise<void>;
  /** true when the user must set a new password before doing anything else */
  mustChange: boolean;
  /** clear the forced state after a successful password change */
  passwordChanged: () => void;
}

const AuthCtx = createContext<Ctx>(null as unknown as Ctx);
export const useAuth = () => useContext(AuthCtx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: Me | null }>('/api/me');
      setUser(r.user);
      return r.user;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // any call refused with 403 must_change_password flips the flag (e.g. an admin reset while the tab was open)
  const [forced, setForced] = useState(false);
  useEffect(() => onMustChangePassword(() => setForced(true)), []);
  const mustChange = !!user && (forced || !!user.mustChangePassword);
  const passwordChanged = useCallback(() => {
    setForced(false);
    setUser((u) => (u ? { ...u, mustChangePassword: false } : u));
  }, []);

  const setCredits = useCallback((n: number) => {
    setUser((u) => (u && typeof n === 'number' ? { ...u, credits: n } : u));
  }, []);

  const logout = useCallback(async () => {
    try { await api.post('/api/auth/logout'); } catch { /* ignore */ }
    setUser(null);
    setForced(false);
  }, []);

  const value = useMemo(() => ({ user, loading, refresh, setCredits, logout, mustChange, passwordChanged }),
    [user, loading, refresh, setCredits, logout, mustChange, passwordChanged]);
  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}
