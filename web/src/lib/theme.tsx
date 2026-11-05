import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ConfigProvider, theme as antdTheme, App as AntApp, type ThemeConfig } from 'antd';
import zhCN from 'antd/es/locale/zh_CN';

export type ThemePref = 'light' | 'dark' | 'system';
const KEY = 'lumi.theme';

function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch { /* ignore */ }
  return 'system';
}

const mq = () => window.matchMedia('(prefers-color-scheme: dark)');

export function resolveTheme(p: ThemePref): 'light' | 'dark' {
  if (p === 'system') return mq().matches ? 'dark' : 'light';
  return p;
}

/** Apply before first render to avoid a flash (no inline script is allowed by CSP). */
export function applyInitialTheme() {
  document.documentElement.dataset.theme = resolveTheme(readPref());
}

interface Ctx { pref: ThemePref; effective: 'light' | 'dark'; setPref: (p: ThemePref) => void }
const ThemeCtx = createContext<Ctx>({ pref: 'system', effective: 'light', setPref: () => {} });
export const useThemePref = () => useContext(ThemeCtx);

export const FONT = "'Noto Sans SC Variable','Noto Sans SC','PingFang SC','Microsoft YaHei',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

const light = { bg: '#f4f0e8', ink: '#1b1915', sub: '#7d766a', line: '#ddd5c6', soft: '#ebe5d9', accent: '#a9472a', card: '#faf7f1', rail: '#efe9de' };
const dark = { bg: '#15130f', ink: '#ece5d8', sub: '#8f877a', line: '#2e2a23', soft: '#1f1c17', accent: '#d9825d', card: '#1a1814', rail: '#110f0c' };

function buildTheme(mode: 'light' | 'dark'): ThemeConfig {
  const c = mode === 'dark' ? dark : light;
  return {
    algorithm: mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
    token: {
      colorPrimary: c.accent,
      colorInfo: c.accent,
      colorSuccess: mode === 'dark' ? '#8fb59a' : '#4d7a5a',
      colorSuccessBg: mode === 'dark' ? 'rgba(143,181,154,.14)' : '#e8eee4',
      colorSuccessBorder: mode === 'dark' ? 'rgba(143,181,154,.35)' : '#c3d3c0',
      colorError: mode === 'dark' ? '#e07a63' : '#b23f2a',
      colorWarning: mode === 'dark' ? '#d6a75c' : '#a8741f',
      colorLink: c.accent,
      colorBgLayout: c.bg,
      colorBgContainer: c.card,
      colorBgElevated: mode === 'dark' ? '#201d18' : '#fbf8f2',
      colorBorder: mode === 'dark' ? '#3a352c' : '#d6cdbc',
      colorBorderSecondary: c.line,
      colorText: c.ink,
      colorTextSecondary: c.sub,
      colorTextTertiary: c.sub,
      colorFillSecondary: c.soft,
      borderRadius: 8,
      borderRadiusLG: 12,
      borderRadiusSM: 5,
      fontFamily: FONT,
      fontSize: 13,
      controlHeight: 34,
      boxShadowSecondary: mode === 'dark' ? '0 12px 40px rgba(0,0,0,.5)' : '0 12px 40px rgba(30,30,25,.12)',
    },
    components: {
      // dark sage primary is light, so its label must be dark to stay readable
      Button: { primaryShadow: 'none', defaultShadow: 'none', fontWeight: 500, ...(mode === 'dark' ? { primaryColor: '#15130f' } : {}) },
      Layout: { siderBg: c.rail, headerBg: c.bg, bodyBg: c.bg, triggerBg: c.rail },
      Menu: { itemBg: 'transparent', subMenuItemBg: 'transparent', itemSelectedBg: mode === 'dark' ? 'rgba(217,130,93,.12)' : 'rgba(169,71,42,.08)', itemSelectedColor: c.accent },
      Segmented: { itemSelectedBg: mode === 'dark' ? '#2a261f' : '#faf7f1', trackBg: c.soft },
      Table: { headerBg: c.soft, headerSplitColor: 'transparent', rowHoverBg: mode === 'dark' ? '#211e18' : '#f0ebe1' },
      Modal: { contentBg: c.card, headerBg: c.card, borderRadiusLG: 14 },
      Card: { colorBgContainer: c.card },
      Drawer: { colorBgElevated: c.card },
    },
  };
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readPref);
  const [sysDark, setSysDark] = useState(() => mq().matches);

  useEffect(() => {
    const m = mq();
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    m.addEventListener('change', fn);
    return () => m.removeEventListener('change', fn);
  }, []);

  const effective: 'light' | 'dark' = pref === 'system' ? (sysDark ? 'dark' : 'light') : pref;

  useEffect(() => {
    document.documentElement.dataset.theme = effective;
    document.documentElement.style.colorScheme = effective;
  }, [effective]);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    try { localStorage.setItem(KEY, p); } catch { /* ignore */ }
  };

  const cfg = useMemo(() => buildTheme(effective), [effective]);
  const value = useMemo(() => ({ pref, effective, setPref }), [pref, effective]);

  return (
    <ThemeCtx.Provider value={value}>
      <ConfigProvider theme={cfg} locale={zhCN} button={{ autoInsertSpace: false }}>
        <AntApp>{children}</AntApp>
      </ConfigProvider>
    </ThemeCtx.Provider>
  );
}
