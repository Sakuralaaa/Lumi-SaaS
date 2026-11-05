import { useState } from 'react';
import { Alert, App, Button, Drawer, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { api } from '../../api/client';
import { useErrorToast } from '../../lib/notify';
import { useLoad } from './useLoad';
import { useAuth } from '../../lib/auth';
import { LedgerTable } from '../../components/LedgerDrawer';
import type { LedgerRow } from '../../api/types';

interface U {
  id: string; email: string; display_name: string | null; role: 'user' | 'admin'; status: 'active' | 'disabled';
  credits: number; daily_limit: number | null; concurrency_override: number | null; created_at: string;
  last_login_at: string | null; invite_code: string | null; images: number; must_change_password?: boolean;
}

export default function Users() {
  const [q, setQ] = useState('');
  const { data, loading, reload } = useLoad<U[]>('/api/admin/users', { q: q || undefined }, []);
  const [edit, setEdit] = useState<U | null>(null);
  const [adj, setAdj] = useState<U | null>(null);
  const [ledger, setLedger] = useState<{ u: U; rows: LedgerRow[]; loading: boolean } | null>(null);
  const [editForm] = Form.useForm();
  const [adjForm] = Form.useForm();
  const { message, modal } = App.useApp();
  const toast = useErrorToast();
  const { user: me } = useAuth();
  const [temp, setTemp] = useState<{ email: string; pw: string } | null>(null);

  const resetPassword = (u: U) => {
    modal.confirm({
      title: `重置 ${u.email} 的密码？`,
      content: '将生成一个临时密码，并让该用户在所有设备上退出登录。用户下次登录后必须设置新密码。',
      okText: '重置密码', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try {
          const r = await api.post<{ tempPassword: string }>(`/api/admin/users/${u.id}/reset-password`);
          setTemp({ email: u.email, pw: r.tempPassword });
          void reload();
        } catch (e) { toast(e); }
      },
    });
  };

  const openEdit = (u: U) => {
    setEdit(u);
    editForm.setFieldsValue({ status: u.status, role: u.role, dailyLimit: u.daily_limit, concurrencyOverride: u.concurrency_override });
  };
  const saveEdit = async () => {
    const v = await editForm.validateFields();
    try {
      await api.patch(`/api/admin/users/${edit!.id}`, {
        status: v.status, role: v.role,
        dailyLimit: v.dailyLimit ?? null, concurrencyOverride: v.concurrencyOverride ?? null,
      });
      message.success('已保存');
      setEdit(null);
      void reload();
    } catch (e) { toast(e); }
  };
  const saveAdj = async () => {
    const v = await adjForm.validateFields();
    try {
      const r = await api.post<{ balance: number }>(`/api/admin/users/${adj!.id}/credits`, { delta: v.delta, note: v.note });
      message.success(`已调整，当前余额 ${r.balance}`);
      setAdj(null);
      adjForm.resetFields();
      void reload();
    } catch (e) { toast(e); }
  };
  const openLedger = async (u: U) => {
    setLedger({ u, rows: [], loading: true });
    try {
      const rows = await api.get<LedgerRow[]>(`/api/admin/users/${u.id}/ledger`);
      setLedger({ u, rows, loading: false });
    } catch (e) { toast(e); setLedger({ u, rows: [], loading: false }); }
  };

  return (
    <>
      <div className="admin-hd">
        <h2>用户</h2>
        <div className="right">
          <Input.Search placeholder="按邮箱搜索" allowClear onSearch={(v) => setQ(v.trim())} style={{ width: 260 }} maxLength={100} />
        </div>
      </div>
      <Table<U> rowKey="id" size="middle" loading={loading} dataSource={data ?? []} scroll={{ x: 1260 }} pagination={{ pageSize: 20 }}
        columns={[
          { title: '邮箱', dataIndex: 'email', fixed: 'left', width: 200, render: (v, r) => (<div><div>{v}</div>{r.display_name && <div className="muted" style={{ fontSize: 12 }}>{r.display_name}</div>}</div>) },
          { title: '角色', dataIndex: 'role', width: 80, render: (v) => (v === 'admin' ? <Tag color="green">管理员</Tag> : <Tag>用户</Tag>) },
          { title: '状态', dataIndex: 'status', width: 130, render: (v, r) => (
            <Space size={4}>
              {v === 'active' ? <Tag color="success">正常</Tag> : <Tag color="error">停用</Tag>}
              {r.must_change_password && <Tag color="warning">待改密</Tag>}
            </Space>
          ) },
          { title: '积分', dataIndex: 'credits', width: 90, align: 'right' },
          { title: '出图', dataIndex: 'images', width: 80, align: 'right' },
          { title: '日限额', dataIndex: 'daily_limit', width: 80, align: 'right', render: (v) => v ?? <span className="muted">默认</span> },
          { title: '并发', dataIndex: 'concurrency_override', width: 70, align: 'right', render: (v) => v ?? <span className="muted">默认</span> },
          { title: '邀请码', dataIndex: 'invite_code', width: 130, render: (v) => <span className="mono">{v ?? '—'}</span> },
          { title: '注册', dataIndex: 'created_at', width: 128, render: (v) => dayjs(v).format('YYYY-MM-DD') },
          { title: '最近登录', dataIndex: 'last_login_at', width: 120, render: (v) => (v ? dayjs(v).fromNow() : '—') },
          {
            title: '操作', key: 'act', fixed: 'right', width: 260,
            render: (_, r) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => openEdit(r)}>编辑</Button>
                <Button size="small" type="link" onClick={() => { setAdj(r); adjForm.resetFields(); }}>调整积分</Button>
                <Button size="small" type="link" onClick={() => openLedger(r)}>流水</Button>
                <Button size="small" type="link" danger disabled={r.id === me?.id} title={r.id === me?.id ? '请使用「修改密码」' : undefined}
                  onClick={() => resetPassword(r)}>重置密码</Button>
              </Space>
            ),
          },
        ]} />

      <Modal title={`编辑用户 · ${edit?.email ?? ''}`} open={!!edit} onCancel={() => setEdit(null)} onOk={saveEdit} okText="保存" cancelText="取消" destroyOnHidden>
        <Form form={editForm} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="status" label="状态"><Select options={[{ value: 'active', label: '正常' }, { value: 'disabled', label: '停用' }]} /></Form.Item>
          <Form.Item name="role" label="角色"><Select options={[{ value: 'user', label: '用户' }, { value: 'admin', label: '管理员' }]} /></Form.Item>
          <Form.Item name="dailyLimit" label="每日出图上限" extra="留空 = 使用全局默认"><InputNumber min={0} max={10000} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="concurrencyOverride" label="并发覆盖" extra="留空 = 使用全局默认"><InputNumber min={1} max={50} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>

      <Modal title={`调整积分 · ${adj?.email ?? ''}`} open={!!adj} onCancel={() => setAdj(null)} onOk={saveAdj} okText="确认调整" cancelText="取消" destroyOnHidden>
        <p className="muted">当前余额 {adj?.credits ?? 0} 积分。正数为增加，负数为扣除。</p>
        <Form form={adjForm} layout="vertical">
          <Form.Item name="delta" label="变动积分" rules={[{ required: true, message: '请输入积分' }, { validator: (_, v) => (v === 0 ? Promise.reject(new Error('不能为 0')) : Promise.resolve()) }]}>
            <InputNumber min={-100000} max={100000} precision={0} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="note" label="备注" rules={[{ required: true, message: '请填写原因' }, { max: 200 }]}>
            <Input.TextArea rows={2} maxLength={200} placeholder="例如：内测补偿" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="临时密码" open={!!temp} onCancel={() => setTemp(null)} maskClosable={false} width={440} destroyOnHidden
        footer={<Button type="primary" onClick={() => setTemp(null)}>我已保存</Button>}>
        {temp && (
          <div style={{ marginTop: 8 }}>
            <p className="muted" style={{ marginTop: 0 }}>{temp.email} 的临时密码：</p>
            <div className="temp-pw">
              <Typography.Text copyable={{ text: temp.pw, tooltips: ['复制', '已复制'] }} className="mono">{temp.pw}</Typography.Text>
            </div>
            <Alert type="warning" showIcon style={{ marginTop: 14 }}
              message="只显示一次" description="关闭后无法再次查看。请通过安全的方式发给用户，用户登录后需立即设置新密码。" />
          </div>
        )}
      </Modal>

      <Drawer title={`积分流水 · ${ledger?.u.email ?? ''}`} open={!!ledger} onClose={() => setLedger(null)} width={560}>
        <LedgerTable rows={ledger?.rows ?? []} loading={!!ledger?.loading} />
      </Drawer>
    </>
  );
}
