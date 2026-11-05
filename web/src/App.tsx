import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spin } from 'antd';
import { ThemeProvider } from './lib/theme';
import { AuthProvider, useAuth } from './lib/auth';
import AppShell from './components/AppShell';
import Login from './pages/Login';
import Register from './pages/Register';
import Home from './pages/Home';
import Landing from './pages/Landing';
import Workbench from './pages/Workbench';
import Gallery from './pages/Gallery';
import Templates from './pages/Templates';
import ModelsLibrary from './pages/ModelsLibrary';
import Products from './pages/Products';
import Tools from './pages/Tools';
import { ForcePassword } from './components/PasswordModal';

const AdminApp = lazy(() => import('./pages/admin/AdminApp'));

function FullSpin() {
  return <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}><Spin /></div>;
}

/** "/" shows the public landing to signed-out visitors; every other app route still requires sign-in. */
function RootGate() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <FullSpin />;
  if (!user && loc.pathname === '/') return <Landing />;
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <AppShell />;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullSpin />;
  if (!user) return <Navigate to="/login?next=%2Fadmin" replace />;
  if (user.role !== 'admin') return <Navigate to="/" replace />;
  return <>{children}</>;
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <FullSpin />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <ForcePassword />
          <Routes>
            <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
            <Route path="/register" element={<GuestOnly><Register /></GuestOnly>} />
            <Route path="/admin/*" element={<RequireAdmin><Suspense fallback={<FullSpin />}><AdminApp /></Suspense></RequireAdmin>} />
            <Route element={<RootGate />}>
              <Route index element={<Home />} />
              <Route path="/p/:id" element={<Workbench />} />
              <Route path="/gallery" element={<Gallery />} />
              <Route path="/templates" element={<Templates />} />
              <Route path="/models" element={<ModelsLibrary />} />
              <Route path="/products" element={<Products />} />
              <Route path="/tools" element={<Tools />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
