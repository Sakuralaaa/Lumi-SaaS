import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, App, Button, Form, Input, Modal } from 'antd';
import { api } from '../api/client';
import { useAuth } from '../lib/auth';
import { useErrorToast } from '../lib/notify';

interface Props {
  open: boolean;
  onClose?: () => void;
  /** non-closable mode after an admin reset: the user must set a new password to continue */
  forced?: boolean;
}

export default function PasswordModal({ open, onClose, forced }: Props) {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const { message } = App.useApp();
  const { passwordChanged, logout, refresh } = useAuth();
  const nav = useNavigate();
  const toast = useErrorToast();

  const submit = async () => {
    const v = await form.validateFields();
    setLoading(true);
    try {
      await api.post('/api/auth/password', { current: v.current, next: v.next });
      message.success(forced ? '密码已更新，欢迎回来' : '密码已修改，其他设备已退出登录');
      form.resetFields();
      passwordChanged();
      void refresh();
      onClose?.();
    } catch (e) {
      toast(e);
    } finally {
      setLoading(false);
    }
  };

  const close = () => { if (forced) return; form.resetFields(); onClose?.(); };
  const signOut = async () => { await logout(); nav('/login', { replace: true }); };

  return (
    <Modal
      title={forced ? '请先设置新密码' : '修改密码'}
      open={open}
      onCancel={close}
      closable={!forced}
      maskClosable={!forced}
      keyboard={!forced}
      destroyOnHidden
      width={420}
      footer={forced ? [
        <Button key="out" type="text" onClick={signOut} style={{ color: 'var(--sub)' }}>退出登录</Button>,
        <Button key="ok" type="primary" loading={loading} onClick={submit}>保存并继续</Button>,
      ] : [
        <Button key="c" onClick={close}>取消</Button>,
        <Button key="ok" type="primary" loading={loading} onClick={submit}>保存</Button>,
      ]}
    >
      {forced && (
        <Alert type="info" showIcon className="soft-alert" style={{ marginTop: 12 }}
          message="管理员已为你重置密码。请用收到的临时密码作为「当前密码」，设置一个只有你知道的新密码。" />
      )}
      <Form form={form} layout="vertical" requiredMark={false} style={{ marginTop: 12 }} onFinish={submit}>
        <Form.Item name="current" label={forced ? '临时密码' : '当前密码'} rules={[{ required: true, message: forced ? '请输入临时密码' : '请输入当前密码' }]}>
          <Input.Password autoComplete="current-password" />
        </Form.Item>
        <Form.Item name="next" label="新密码" rules={[{ required: true, message: '请输入新密码' }, { min: 8, message: '密码至少 8 位' }, { max: 128, message: '密码太长' },
          ({ getFieldValue }) => ({
            validator: (_, v) => (!v || v !== getFieldValue('current') ? Promise.resolve() : Promise.reject(new Error('新密码不能和当前密码相同'))),
          })]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="confirm" label="确认新密码" dependencies={['next']}
          rules={[{ required: true, message: '请再输入一次' }, ({ getFieldValue }) => ({
            validator: (_, v) => (!v || v === getFieldValue('next') ? Promise.resolve() : Promise.reject(new Error('两次输入不一致'))),
          })]}>
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </Form>
    </Modal>
  );
}

/** Mounted once inside the router: shows the forced modal whenever the session requires a new password. */
export function ForcePassword() {
  const { mustChange } = useAuth();
  return <PasswordModal open={mustChange} forced />;
}
