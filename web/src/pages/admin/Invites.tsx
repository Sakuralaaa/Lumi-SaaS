import { useState } from 'react';
import { App, Button, Card, Col, Form, Input, InputNumber, Popconfirm, Row, Table, Tag } from 'antd';
import { CopyOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { api } from '../../api/client';
import { useErrorToast } from '../../lib/notify';
import { useLoad } from './useLoad';

interface Inv {
  id: string; code: string; credits: number; max_uses: number; used_count: number; daily_limit: number | null;
  expires_at: string | null; status: 'active' | 'revoked' | string; batch: string | null; note: string | null; created_at: string; used_by: string[] | string | null;
}

/** `used_by` should be string[], but a citext[] aggregate arrives as the raw Postgres literal "{a,b}". Accept both. */
function parsePgArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1);
    if (!inner) return [];
    return inner.split(',').map((x) => x.replace(/^"(.*)"$/, '$1')).filter((x) => x && x !== 'NULL');
  }
  return [];
}

export default function Invites() {
  const [batch, setBatch] = useState('');
  const { data, loading, reload } = useLoad<Inv[]>('/api/admin/invites', { batch: batch || undefined }, []);
  const [codes, setCodes] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const toast = useErrorToast();

  const generate = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      const body: Record<string, unknown> = { count: v.count, credits: v.credits, maxUses: v.maxUses ?? 1 };
      body.dailyLimit = v.dailyLimit ?? null;
      body.expiresInDays = v.expiresInDays ?? null;
      if (v.batch?.trim()) body.batch = v.batch.trim();
      if (v.note?.trim()) body.note = v.note.trim();
      const r = await api.post<{ codes: string[] }>('/api/admin/invites', body);
      setCodes(r.codes);
      message.success(`已生成 ${r.codes.length} 个邀请码`);
      void reload();
    } catch (e) { toast(e); } finally { setBusy(false); }
  };

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); message.success('已复制'); } catch { message.error('复制失败，请手动选择复制'); }
  };

  const revoke = async () => {
    try {
      const r = await api.post<{ revoked: number }>('/api/admin/invites/revoke', { ids: selected });
      message.success(`已作废 ${r.revoked} 个`);
      setSelected([]);
      void reload();
    } catch (e) { toast(e); }
  };

  const statusOf = (r: Inv) => {
    if (r.status !== 'active') return <Tag color="error">已作废</Tag>;
    if (r.expires_at && dayjs(r.expires_at).isBefore(dayjs())) return <Tag>已过期</Tag>;
    if (r.used_count >= r.max_uses) return <Tag>已用完</Tag>;
    return <Tag color="success">可用</Tag>;
  };

  return (
    <>
      <div className="admin-hd"><h2>邀请码</h2></div>
      <Row gutter={16} style={{ marginBottom: 16 }}>
        <Col span={codes.length ? 14 : 24}>
          <Card size="small" title="批量生成">
            <Form form={form} layout="vertical" initialValues={{ count: 10, credits: 200, maxUses: 1, expiresInDays: 30 }}>
              <Row gutter={12}>
                <Col span={4}><Form.Item name="count" label="数量" rules={[{ required: true }]}><InputNumber min={1} max={200} style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={4}><Form.Item name="credits" label="赠送积分" rules={[{ required: true }]}><InputNumber min={0} max={100000} style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={4}><Form.Item name="maxUses" label="可用次数"><InputNumber min={1} max={1000} style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={4}><Form.Item name="dailyLimit" label="每日上限"><InputNumber min={0} max={10000} placeholder="默认" style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={4}><Form.Item name="expiresInDays" label="有效天数"><InputNumber min={1} max={365} placeholder="不限" style={{ width: '100%' }} /></Form.Item></Col>
                <Col span={4}><Form.Item name="batch" label="批次名"><Input maxLength={60} placeholder="如 beta-10" /></Form.Item></Col>
              </Row>
              <Row gutter={12} align="bottom">
                <Col flex="auto"><Form.Item name="note" label="备注" style={{ marginBottom: 0 }}><Input maxLength={200} placeholder="选填" /></Form.Item></Col>
                <Col><Button type="primary" onClick={generate} loading={busy}>生成</Button></Col>
              </Row>
            </Form>
          </Card>
        </Col>
        {codes.length > 0 && (
          <Col span={10}>
            <Card size="small" title={`本次生成 ${codes.length} 个`} extra={<Button size="small" icon={<CopyOutlined />} onClick={() => copy(codes.join('\n'))}>复制全部</Button>}>
              <div className="codes">{codes.join('\n')}</div>
            </Card>
          </Col>
        )}
      </Row>

      <div className="admin-hd" style={{ marginBottom: 12 }}>
        <Input.Search placeholder="按批次筛选" allowClear onSearch={(v) => setBatch(v.trim())} style={{ width: 240 }} maxLength={60} />
        <div className="right">
          <Popconfirm title={`作废选中的 ${selected.length} 个邀请码？`} onConfirm={revoke} okText="作废" cancelText="取消" disabled={!selected.length}>
            <Button danger disabled={!selected.length}>作废选中{selected.length ? ` (${selected.length})` : ''}</Button>
          </Popconfirm>
        </div>
      </div>
      <Table<Inv> rowKey="id" size="middle" loading={loading} dataSource={data ?? []} pagination={{ pageSize: 30 }} scroll={{ x: 1100 }}
        rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), getCheckboxProps: (r) => ({ disabled: r.status !== 'active' }) }}
        columns={[
          { title: '邀请码', dataIndex: 'code', width: 160, render: (v) => <span className="mono" style={{ cursor: 'copy' }} onClick={() => copy(v)}>{v}</span> },
          { title: '状态', key: 's', width: 90, render: (_, r) => statusOf(r) },
          { title: '积分', dataIndex: 'credits', width: 70, align: 'right' },
          { title: '使用', key: 'u', width: 80, align: 'right', render: (_, r) => `${r.used_count}/${r.max_uses}` },
          { title: '日上限', dataIndex: 'daily_limit', width: 80, align: 'right', render: (v) => v ?? '—' },
          { title: '过期', dataIndex: 'expires_at', width: 110, render: (v) => (v ? dayjs(v).format('YYYY-MM-DD') : '不限') },
          { title: '批次', dataIndex: 'batch', width: 110, render: (v) => v ?? '—' },
          { title: '使用者', dataIndex: 'used_by', render: (v: unknown) => { const list = parsePgArray(v); return list.length ? list.join('、') : <span className="muted">—</span>; } },
          { title: '备注', dataIndex: 'note', width: 140, ellipsis: true, render: (v) => v ?? '' },
          { title: '创建', dataIndex: 'created_at', width: 110, render: (v) => dayjs(v).format('MM-DD HH:mm') },
        ]} />
    </>
  );
}
