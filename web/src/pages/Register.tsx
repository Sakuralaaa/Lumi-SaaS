import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Form, Input } from 'antd';
import { GiftOutlined, LockOutlined, MailOutlined, UserOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { useErrorToast } from '../lib/notify';
import { AuthBrand } from './Login';

interface V { email: string; password: string; inviteCode: string; displayName?: string }

export default function Register() {
  const [loading, setLoading] = useState(false);
  const { refresh } = useAuth();
  const nav = useNavigate();
  const toast = useErrorToast();

  const onFinish = async (v: V) => {
    setLoading(true);
    try {
      const body: Record<string, string> = {
        email: v.email.trim(),
        password: v.password,
        inviteCode: v.inviteCode.trim().toUpperCase(),
      };
      if (v.displayName?.trim()) body.displayName = v.displayName.trim();
      await api.post('/api/auth/register', body);
      await refresh();
      nav('/', { replace: true });
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
        <h1>创建账号</h1>
        <p className="sub">内测阶段，需要邀请码才能注册</p>
        <Form layout="vertical" requiredMark={false} onFinish={onFinish} autoComplete="on">
          <Form.Item name="email" rules={[{ required: true, message: '请输入邮箱' }, { type: 'email', message: '邮箱格式不正确' }]}>
            <Input size="large" prefix={<MailOutlined />} placeholder="邮箱" autoComplete="email" maxLength={254} />
          </Form.Item>
          <Form.Item name="password" rules={[{ required: true, message: '请设置密码' }, { min: 8, message: '密码至少 8 位' }, { max: 128, message: '密码太长' }]}>
            <Input.Password size="large" prefix={<LockOutlined />} placeholder="密码（至少 8 位）" autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="inviteCode" rules={[{ required: true, message: '请输入邀请码' }, { pattern: /^[A-Za-z0-9-]{6,32}$/, message: '邀请码格式不正确' }]}>
            <Input size="large" prefix={<GiftOutlined />} placeholder="邀请码" autoComplete="off" maxLength={32} style={{ textTransform: 'uppercase' }} />
          </Form.Item>
          <Form.Item name="displayName" rules={[{ max: 40, message: '昵称最多 40 字' }]}>
            <Input size="large" prefix={<UserOutlined />} placeholder="昵称（选填）" autoComplete="nickname" maxLength={40} />
          </Form.Item>
          <Button className="btn-ink" htmlType="submit" block size="large" loading={loading} style={{ height: 46, marginTop: 4 }}>
            注册并登录
          </Button>
        </Form>
        <div className="auth-foot">已有账号？<Link to="/login">去登录</Link></div>
      </div>
    </div>
  );
}
