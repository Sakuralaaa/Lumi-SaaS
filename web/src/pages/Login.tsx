import Brand from '../components/Brand';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Form, Input } from 'antd';
import { LockOutlined, MailOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { useErrorToast } from '../lib/notify';

/** Only same-app paths are allowed as post-login targets (no open redirects). */
export function safeNext(n: string | null): string {
  if (!n || !n.startsWith('/') || n.startsWith('//') || n.startsWith('/\\')) return '/';
  if (n.startsWith('/login') || n.startsWith('/register')) return '/';
  return n;
}

export function AuthBrand() {
  return (
    <>
      <Brand />
      <div className="auth-strip" aria-hidden>
        <img src="/img/r1.jpg" alt="" />
        <img src="/img/c-r2.jpg" alt="" />
        <img src="/img/r3.jpg" alt="" />
        <img src="/img/c-r3.jpg" alt="" />
      </div>
    </>
  );
}

export default function Login() {
  const [loading, setLoading] = useState(false);
  const { refresh } = useAuth();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const toast = useErrorToast();

  const onFinish = async (v: { email: string; password: string }) => {
    setLoading(true);
    try {
      await api.post('/api/auth/login', { email: v.email.trim(), password: v.password });
      await refresh();
      nav(safeNext(sp.get('next')), { replace: true });
    } catch (e) {
      toast(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <AuthBrand />
        <h1>欢迎回来</h1>
        <p className="sub">登录后继续你的商品图创作</p>
        <Form layout="vertical" requiredMark={false} onFinish={onFinish} autoComplete="on">
          <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
            <Input size="large" prefix={<MailOutlined />} placeholder="邮箱" autoComplete="email" />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="密码" autoComplete="current-password" />
          </Form.Item>
          <Button className="btn-ink" htmlType="submit" block size="large" loading={loading} style={{ height: 46, marginTop: 4 }}>
            登录
          </Button>
        </Form>
        <div className="auth-foot">还没有账号？<Link to="/register">用邀请码注册</Link></div>
      </div>
    </div>
  );
}
