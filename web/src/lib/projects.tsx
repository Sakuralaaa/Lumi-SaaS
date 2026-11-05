import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api/client';
import type { Mode, Options, Project } from '../api/types';

interface Ctx {
  projects: Project[];
  loaded: boolean;
  options: Options | null;
  reload: () => Promise<void>;
  patchLocal: (id: string, patch: Partial<Project>) => void;
  create: (mode: Mode, name?: string) => Promise<string>;
  remove: (id: string) => Promise<void>;
  newOpen: boolean;
  openNew: () => void;
  closeNew: () => void;
}

const ProjectsCtx = createContext<Ctx>(null as unknown as Ctx);
export const useProjects = () => useContext(ProjectsCtx);

const DEFAULT_OPTIONS: Options = {
  prices: { standard: 2, hd: 4 },
  ratios: ['1:1', '3:4', '4:3', '9:16', '16:9'],
  tags: [],
  maxImagesPerJob: 8,
};

export function ProjectsProvider({ children }: { children: ReactNode }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  const reload = useCallback(async () => {
    try {
      const list = await api.get<Project[]>('/api/projects');
      setProjects(Array.isArray(list) ? list : []);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
    api.get<Options>('/api/options').then(setOptions).catch(() => setOptions(DEFAULT_OPTIONS));
    // signed cover URLs expire after ~15 min; refresh the list periodically
    const t = window.setInterval(() => { void reload(); }, 10 * 60 * 1000);
    return () => window.clearInterval(t);
  }, [reload]);

  const patchLocal = useCallback((id: string, patch: Partial<Project>) => {
    setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }, []);

  const create = useCallback(async (mode: Mode, name?: string) => {
    const r = await api.post<{ id: string; name: string; mode: Mode; created_at: string }>('/api/projects', name ? { name, mode } : { mode });
    const now = new Date().toISOString();
    setProjects((ps) => [{ id: r.id, name: r.name, mode: r.mode, createdAt: r.created_at ?? now, updatedAt: now, cover: null }, ...ps]);
    return r.id;
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.del(`/api/projects/${id}`);
    setProjects((ps) => ps.filter((p) => p.id !== id));
  }, []);

  const value = useMemo(() => ({
    projects, loaded, options: options ?? null, reload, patchLocal, create, remove,
    newOpen, openNew: () => setNewOpen(true), closeNew: () => setNewOpen(false),
  }), [projects, loaded, options, reload, patchLocal, create, remove, newOpen]);

  return <ProjectsCtx.Provider value={value}>{children}</ProjectsCtx.Provider>;
}

export function useOptions(): Options {
  return useProjects().options ?? DEFAULT_OPTIONS;
}
