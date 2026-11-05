import Brand from './Brand';
import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Drawer } from 'antd';
import { MenuOutlined, PlusOutlined } from '@ant-design/icons';
import ErrorBoundary from './ErrorBoundary';
import { ProjectsProvider, useProjects } from '../lib/projects';
import { useAuth } from '../lib/auth';
import { useIsMobile } from '../lib/useMobile';
import Sidebar from './Sidebar';
import NewProjectModal from './NewProjectModal';
import LedgerDrawer from './LedgerDrawer';
import PasswordModal from './PasswordModal';

function MobileBar({ onMenu }: { onMenu: () => void }) {
  const { user } = useAuth();
  const { openNew } = useProjects();
  return (
    <header className="mbar">
      <button className="mbar-btn" onClick={onMenu} aria-label="菜单"><MenuOutlined /></button>
      <Brand compact />
      <span className="mbar-credits">{(user?.credits ?? 0).toLocaleString('zh-CN')} 积分</span>
      <button className="mbar-btn" onClick={openNew} aria-label="新建项目"><PlusOutlined /></button>
    </header>
  );
}

export default function AppShell() {
  const [ledger, setLedger] = useState(false);
  const [pwd, setPwd] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const loc = useLocation();
  const mobile = useIsMobile();
  useEffect(() => { setDrawer(false); }, [loc.pathname]);
  useEffect(() => { if (!mobile) setDrawer(false); }, [mobile]);

  const openLedger = () => { setDrawer(false); setLedger(true); };
  const openPwd = () => { setDrawer(false); setPwd(true); };

  return (
    <ProjectsProvider>
      <div className={`shell${mobile ? ' is-mobile' : ''}`}>
        {mobile ? (
          <Drawer open={drawer} onClose={() => setDrawer(false)} placement="left" width={288} closable={false}
            styles={{ body: { padding: 0 } }} rootClassName="rail-drawer">
            <Sidebar onLedger={openLedger} onPassword={openPwd} onNavigate={() => setDrawer(false)} />
          </Drawer>
        ) : (
          <Sidebar onLedger={openLedger} onPassword={openPwd} />
        )}
        <main className="pane">
          {mobile && <MobileBar onMenu={() => setDrawer(true)} />}
          <ErrorBoundary key={loc.pathname}><Outlet /></ErrorBoundary>
        </main>
      </div>
      <NewProjectModal />
      <LedgerDrawer open={ledger} onClose={() => setLedger(false)} />
      <PasswordModal open={pwd} onClose={() => setPwd(false)} />
    </ProjectsProvider>
  );
}
