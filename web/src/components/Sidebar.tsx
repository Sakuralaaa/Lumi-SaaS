import Brand from './Brand';
import { useMemo, useState } from 'react';
import { NavLink, useMatch, useNavigate } from 'react-router-dom';
import { App, Dropdown, type MenuProps } from 'antd';
import {
  AppstoreOutlined, BulbOutlined, HomeOutlined, DeleteOutlined, DesktopOutlined, EllipsisOutlined, KeyOutlined,
  LogoutOutlined, MoonOutlined, PictureOutlined, PlusOutlined, SettingOutlined, SunOutlined, UserOutlined, ShoppingOutlined, ToolOutlined, WalletOutlined,
} from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAuth } from '../lib/auth';
import { useProjects } from '../lib/projects';
import { useThemePref, type ThemePref } from '../lib/theme';
import { useErrorToast } from '../lib/notify';
import { safeUrl } from '../api/client';
import { MODE_LABELS } from '../lib/labels';
import type { Project } from '../api/types';

function groupProjects(ps: Project[]) {
  const today = dayjs().startOf('day');
  const week = today.subtract(6, 'day');
  const g: { label: string; items: Project[] }[] = [
    { label: '今天', items: [] }, { label: '本周', items: [] }, { label: '更早', items: [] },
  ];
  for (const p of ps) {
    const t = dayjs(p.updatedAt || p.createdAt);
    if (!t.isBefore(today)) g[0].items.push(p);
    else if (!t.isBefore(week)) g[1].items.push(p);
    else g[2].items.push(p);
  }
  return g.filter((x) => x.items.length);
}

function ProjectRow({ p, active }: { p: Project; active: boolean }) {
  const nav = useNavigate();
  const { remove } = useProjects();
  const { modal, message } = App.useApp();
  const toast = useErrorToast();
  const [open, setOpen] = useState(false);
  const cover = safeUrl(p.cover);

  const items: MenuProps['items'] = [{ key: 'del', danger: true, icon: <DeleteOutlined />, label: '删除项目' }];
  const onMenu: MenuProps['onClick'] = ({ key, domEvent }) => {
    domEvent.stopPropagation();
    if (key === 'del') {
      modal.confirm({
        title: '删除这个项目？',
        content: '项目里的所有生成记录都会一起删除，且无法恢复。',
        okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
        onOk: async () => {
          try {
            await remove(p.id);
            message.success('已删除');
            if (active) nav('/', { replace: true });
          } catch (e) { toast(e); }
        },
      });
    }
  };

  return (
    <div className={`proj${active ? ' on' : ''}`} onClick={() => nav(`/p/${p.id}`)} role="link" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') nav(`/p/${p.id}`); }}>
      <span className="cv">{cover ? <img src={cover} alt="" loading="lazy" /> : <PictureOutlined />}</span>
      <span className="tx">
        <b title={p.name}>{p.name}</b>
        <em>{MODE_LABELS[p.mode] ?? ''} · {dayjs(p.updatedAt || p.createdAt).fromNow()}</em>
      </span>
      <Dropdown menu={{ items, onClick: onMenu }} trigger={['click']} onOpenChange={setOpen} placement="bottomRight">
        <span className={`more${open ? ' open' : ''}`} onClick={(e) => e.stopPropagation()} role="button" aria-label="更多">
          <EllipsisOutlined />
        </span>
      </Dropdown>
    </div>
  );
}

export default function Sidebar({ onLedger, onPassword, onNavigate }: { onLedger: () => void; onPassword: () => void; onNavigate?: () => void }) {
  const { user, logout } = useAuth();
  const { projects, loaded, openNew } = useProjects();
  const { pref, setPref } = useThemePref();
  const nav = useNavigate();
  const m = useMatch('/p/:id');
  const activeId = m?.params.id;
  const groups = useMemo(() => groupProjects(projects), [projects]);

  const name = user?.display_name || user?.email?.split('@')[0] || '';
  const initial = (name.trim()[0] || 'L').toUpperCase();

  const menuItems: MenuProps['items'] = [
    { key: 'ledger', icon: <WalletOutlined />, label: '积分明细' },
    { key: 'password', icon: <KeyOutlined />, label: '修改密码' },
    ...(user?.role === 'admin' ? [{ key: 'admin', icon: <SettingOutlined />, label: '管理后台' }] : []),
    { type: 'divider' as const },
    { key: 'logout', icon: <LogoutOutlined />, label: '退出登录' },
  ];
  const onMenu: MenuProps['onClick'] = async ({ key }) => {
    if (key === 'ledger') onLedger();
    else if (key === 'password') onPassword();
    else if (key === 'admin') { onNavigate?.(); nav('/admin'); }
    else if (key === 'logout') { await logout(); nav('/login', { replace: true }); }
  };

  const themes: { k: ThemePref; label: string; icon: React.ReactNode }[] = [
    { k: 'light', label: '白天', icon: <SunOutlined /> },
    { k: 'dark', label: '黑夜', icon: <MoonOutlined /> },
    { k: 'system', label: '系统', icon: <DesktopOutlined /> },
  ];

  return (
    <aside className="rail">
      <Brand />
      <button className="rail-new" onClick={() => { onNavigate?.(); openNew(); }}><PlusOutlined /> 新建项目</button>
      <nav className="rnav">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'on' : '')}><HomeOutlined />首页</NavLink>
        <NavLink to="/gallery" className={({ isActive }) => (isActive ? 'on' : '')}><AppstoreOutlined />作品库</NavLink>
        <NavLink to="/models" className={({ isActive }) => (isActive ? 'on' : '')}><UserOutlined />模特库</NavLink>
        <NavLink to="/products" className={({ isActive }) => (isActive ? 'on' : '')}><ShoppingOutlined />商品库</NavLink>
        <NavLink to="/tools" className={({ isActive }) => (isActive ? 'on' : '')}><ToolOutlined />工具箱</NavLink>
        <NavLink to="/templates" className={({ isActive }) => (isActive ? 'on' : '')}><BulbOutlined />灵感模板</NavLink>
      </nav>
      <div className="rail-list">
        {groups.map((g) => (
          <div key={g.label}>
            <div className="grp">{g.label}</div>
            {g.items.map((p) => <ProjectRow key={p.id} p={p} active={p.id === activeId} />)}
          </div>
        ))}
        {loaded && !projects.length && (
          <div className="rail-empty">还没有项目。<br />点「新建项目」开始第一组商品图。</div>
        )}
      </div>
      <div className="theme-seg" role="radiogroup" aria-label="主题">
        {themes.map((t) => (
          <button key={t.k} className={pref === t.k ? 'on' : ''} onClick={() => setPref(t.k)} role="radio" aria-checked={pref === t.k}>
            {t.icon}{t.label}
          </button>
        ))}
      </div>
      <Dropdown menu={{ items: menuItems, onClick: onMenu }} trigger={['click']} placement="topLeft" getPopupContainer={(n) => n.parentElement ?? document.body}>
        <div className="me" role="button" tabIndex={0}>
          <div className="av">{initial}</div>
          <span className="tx">
            <b title={user?.email}>{name}</b>
            <em>{(user?.credits ?? 0).toLocaleString('zh-CN')} 积分</em>
          </span>
          <EllipsisOutlined className="dots" />
        </div>
      </Dropdown>
    </aside>
  );
}
