import { useState } from 'react';
import { App, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag } from 'antd';
import { PlusOutlined, SyncOutlined } from '@ant-design/icons';
import { api } from '../../api/client';
import { useErrorToast } from '../../lib/notify';
import { useLoad } from './useLoad';

interface Ch { id: string; name: string; vendor: string; base_url: string; key_last4: string | null; status: 'active' | 'disabled'; timeout_ms: number; purpose?: 'image' | 'chat' }

/** Shown only when the backend returns a `purpose` flag on channels. */
export const PURPOSES = [
  { value: 'image', label: '图片生成' },
  { value: 'chat', label: '对话 / 规划' },
];

const VENDORS = [
  { value: 'gptchat2api', label: 'gptchat2api' },
  { value: 'grok2api', label: 'grok2api' },
  { value: 'openai_compat', label: 'OpenAI 兼容' },
];

export default function Channels() {
  const { data, loading, reload } = useLoad<Ch[]>('/api/admin/channels', undefined, []);
  const [editing, setEditing] = useState<Ch | 'new' | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [form] = Form.useForm();
  const { message, modal } = App.useApp();
  const toast = useErrorToast();
  // channels carry a purpose (image relay vs. chat/planner LLM); older backends omit it
  const hasPurpose = !(data ?? []).length || (data ?? []).some((c) => c.purpose !== undefined);

  const open = (c: Ch | 'new') => {
    setEditing(c);
    form.resetFields();
    if (c === 'new') form.setFieldsValue({ vendor: 'openai_compat', status: 'active', timeoutMs: 300000, purpose: 'image' });
    else form.setFieldsValue({ name: c.name, vendor: c.vendor, baseUrl: c.base_url, status: c.status, timeoutMs: c.timeout_ms, apiKey: '', purpose: c.purpose ?? 'image' });
  };

  const save = async () => {
    const v = await form.validateFields();
    const body: Record<string, unknown> = { name: v.name, vendor: v.vendor, baseUrl: v.baseUrl, status: v.status, timeoutMs: v.timeoutMs };
    if (v.apiKey) body.apiKey = v.apiKey; // write-only; omitted = keep existing
    if (hasPurpose && v.purpose) body.purpose = v.purpose;
    try {
      if (editing === 'new') await api.post('/api/admin/channels', body);
      else if (editing) await api.patch(`/api/admin/channels/${editing.id}`, body);
      message.success('已保存');
      form.resetFields();
      setEditing(null);
      void reload();
    } catch (e) { toast(e); }
  };

  const del = async (c: Ch) => {
    try { await api.del(`/api/admin/channels/${c.id}`); message.success('已删除'); void reload(); } catch (e) { toast(e); }
  };

  const sync = async (c: Ch) => {
    setSyncing(c.id);
    try {
      const r = await api.post<{ total: number; imageModels: string[]; chatModels?: string[]; purpose?: string }>(`/api/admin/channels/${c.id}/sync`);
      if (r.purpose === 'chat' || c.purpose === 'chat') {
        const chat = r.chatModels ?? [];
        modal.info({
          title: `同步完成 · ${c.name}`,
          width: 520,
          content: (
            <div>
              <p>上游共 {r.total} 个模型，其中对话模型 {chat.length} 个。对话渠道只用于规划，请到「定价与设置 → 规划模型」中选择。</p>
              <div className="codes">{chat.length ? chat.join('\n') : '（无）'}</div>
            </div>
          ),
        });
        return;
      }
      modal.info({
        title: `同步完成 · ${c.name}`,
        width: 520,
        content: (
          <div>
            <p>上游共 {r.total} 个模型，其中图片模型 {r.imageModels.length} 个（新模型默认未启用，请到「模型」页开启）。</p>
            <div className="codes">{r.imageModels.length ? r.imageModels.join('\n') : '（无）'}</div>
          </div>
        ),
      });
    } catch (e) { toast(e); } finally { setSyncing(null); }
  };

  return (
    <>
      <div className="admin-hd">
        <h2>上游渠道</h2>
        <div className="right"><Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>新增渠道</Button></div>
      </div>
      <Table<Ch> rowKey="id" loading={loading} dataSource={data ?? []} pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '类型', dataIndex: 'vendor', render: (v) => <Tag>{VENDORS.find((x) => x.value === v)?.label ?? v}</Tag> },
          ...(hasPurpose ? [{
            title: '用途', dataIndex: 'purpose', width: 110,
            render: (v: string) => (v === 'chat' ? <Tag color="blue">对话 / 规划</Tag> : <Tag color="green">图片生成</Tag>),
          }] : []),
          { title: 'Base URL', dataIndex: 'base_url', render: (v) => <span className="mono">{v}</span> },
          { title: 'API Key', dataIndex: 'key_last4', render: (v) => <span className="mono">{v ? `••••${v}` : '—'}</span> },
          { title: '状态', dataIndex: 'status', render: (v) => (v === 'active' ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
          { title: '超时', dataIndex: 'timeout_ms', align: 'right', render: (v) => `${Math.round(v / 1000)}s` },
          {
            title: '操作', key: 'a', width: 230,
            render: (_, r) => (
              <Space size={4}>
                <Button size="small" icon={<SyncOutlined spin={syncing === r.id} />} onClick={() => sync(r)} disabled={!!syncing}>同步模型</Button>
                <Button size="small" type="link" onClick={() => open(r)}>编辑</Button>
                <Popconfirm title="删除该渠道？其下模型与绑定会一并失效" onConfirm={() => del(r)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                  <Button size="small" type="link" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]} />

      <Modal title={editing === 'new' ? '新增渠道' : '编辑渠道'} open={!!editing} onCancel={() => { form.resetFields(); setEditing(null); }} onOk={save} okText="保存" cancelText="取消" destroyOnHidden>
        <Form form={form} layout="vertical" style={{ marginTop: 12 }} autoComplete="off">
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }, { max: 60 }]}><Input maxLength={60} /></Form.Item>
          <Form.Item name="vendor" label="类型" rules={[{ required: true }]}><Select options={VENDORS} /></Form.Item>
          {hasPurpose && (
            <Form.Item name="purpose" label="用途" extra="出图中转选「图片生成」；规划用的对话大模型（OpenAI 兼容、支持看图）选「对话 / 规划」">
              <Select options={PURPOSES} />
            </Form.Item>
          )}
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请输入地址' }, { type: 'url', message: '地址格式不正确' }]}>
            <Input placeholder="https://example.com" maxLength={300} />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key"
            extra={editing && editing !== 'new' ? `仅可写入，不会回显。留空则保持当前密钥（尾号 ${editing.key_last4 ?? '—'}）` : '仅可写入，保存后不会回显'}
            rules={editing === 'new' ? [{ required: true, message: '请输入 API Key' }] : []}>
            <Input.Password autoComplete="new-password" visibilityToggle={false} maxLength={500} placeholder={editing && editing !== 'new' ? '留空保持不变' : ''} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="status" label="状态"><Select style={{ width: 140 }} options={[{ value: 'active', label: '启用' }, { value: 'disabled', label: '停用' }]} /></Form.Item>
            <Form.Item name="timeoutMs" label="超时（毫秒）"><InputNumber min={10000} max={600000} step={10000} style={{ width: 180 }} /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}
