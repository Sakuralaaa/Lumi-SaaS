import Brand from '../../components/Brand';
import { useEffect, useState } from 'react';
import { Layout, Menu, Button, Segmented, Drawer } from 'antd';
import { MenuOutlined } from '@ant-design/icons';
import { useIsMobile } from '../../lib/useMobile';
import {
  ApiOutlined, AuditOutlined, BranchesOutlined, DashboardOutlined, DollarOutlined, GiftOutlined,
  BulbOutlined, LeftOutlined, PictureOutlined, TeamOutlined, ClusterOutlined,
} from '@ant-design/icons';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useThemePref, type ThemePref } from '../../lib/theme';
import Overview from './Overview';
import Users from './Users';
import Invites from './Invites';
import Channels from './Channels';
import Models from './Models';
import Routing from './Routing';
import Pricing from './Pricing';
import Items from './Items';
import Audit from './Audit';
import AdminTemplates from './Templates';
import ErrorBoundary from '../../components/ErrorBoundary';

const MENU = [
  { key: '', icon: <DashboardOutlined />, label: '概览' },
  { key: 'users', icon: <TeamOutlined />, label: '用户' },
  { key: 'invites', icon: <GiftOutlined />, label: '邀请码' },
  { key: 'channels', icon: <ApiOutlined />, label: '上游渠道' },
  { key: 'models', icon: <ClusterOutlined />, label: '模型' },
  { key: 'routing', icon: <BranchesOutlined />, label: '路由' },
  { key: 'pricing', icon: <DollarOutlined />, label: '定价与设置' },
  { key: 'templates', icon: <BulbOutlined />, label: '灵感模板' },
  { key: 'items', icon: <PictureOutlined />, label: '生成记录' },
  { key: 'audit', icon: <AuditOutlined />, label: '审计日志' },
];

export default function AdminApp() {
  const loc = useLocation();
  const nav = useNavigate();
  const { pref, setPref } = useThemePref();
  const seg = loc.pathname.replace(/^\/admin\/?/, '').split('/')[0] ?? '';
  const mobile = useIsMobile();
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [loc.pathname]);

  const side = (
    <>
        <div className="admin-logo"><Brand sub="管理后台" /></div>
        <Menu
          mode="inline"
          selectedKeys={[seg]}
          items={MENU}
          onClick={({ key }) => nav(key ? `/admin/${key}` : '/admin')}
          style={{ borderInlineEnd: 0, padding: '0 8px' }}
        />
        <div style={{ position: 'absolute', bottom: 16, left: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <Segmented size="small" block value={pref} onChange={(v) => setPref(v as ThemePref)}
            options={[{ value: 'light', label: '白天' }, { value: 'dark', label: '黑夜' }, { value: 'system', label: '系统' }]} />
          <Button icon={<LeftOutlined />} onClick={() => nav('/')} block>返回创作</Button>
        </div>
    </>
  );

  return (
    <Layout className={`admin${mobile ? ' is-mobile' : ''}`}>
      {mobile ? (
        <Drawer open={open} onClose={() => setOpen(false)} placement="left" width={240} closable={false}
          styles={{ body: { padding: 0, position: 'relative' } }}>{side}</Drawer>
      ) : (
        <Layout.Sider width={220} theme="light">{side}</Layout.Sider>
      )}
      <Layout.Content className="admin-content">
        {mobile && (
          <header className="mbar admin-mbar">
            <button className="mbar-btn" onClick={() => setOpen(true)} aria-label="菜单"><MenuOutlined /></button>
            <div className="logo"><i />{MENU.find((m) => m.key === seg)?.label ?? '管理后台'}</div>
          </header>
        )}
        <ErrorBoundary key={loc.pathname}>
        <Routes>
          <Route index element={<Overview />} />
          <Route path="users" element={<Users />} />
          <Route path="invites" element={<Invites />} />
          <Route path="channels" element={<Channels />} />
          <Route path="models" element={<Models />} />
          <Route path="routing" element={<Routing />} />
          <Route path="pricing" element={<Pricing />} />
          <Route path="templates" element={<AdminTemplates />} />
          <Route path="items" element={<Items />} />
          <Route path="audit" element={<Audit />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
        </ErrorBoundary>
      </Layout.Content>
    </Layout>
  );
}

