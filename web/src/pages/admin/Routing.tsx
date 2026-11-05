import { useState } from 'react';
import { App, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag } from 'antd';
import { PlusOutlined } from '@ant-design/icons';
import { api } from '../../api/client';
import { useErrorToast } from '../../lib/notify';
import { useLoad } from './useLoad';
import type { RealModel } from './Models';
import { TAG_LABELS } from '../../lib/labels';

interface Binding { id: string; real_model_id: string; model_id: string; channel_name: string; priority: number; weight: number; enabled: boolean }
interface PM { key: string; display_name: string; enabled: boolean; bindings: Binding[] }
interface Rule {
  id: string; name: string; priority: number; enabled: boolean; primary_model: string; fallback_model: string | null;
  match: { quality?: 'standard' | 'hd'; min_refs?: number; max_refs?: number; tags_any?: string[] };
}

function PlatformCard({ pm, models, reload }: { pm: PM; models: RealModel[]; reload: () => void }) {
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm();
  const toast = useErrorToast();
  const { message } = App.useApp();

  const patch = async (b: Binding, body: Partial<Pick<Binding, 'priority' | 'weight' | 'enabled'>>) => {
    try { await api.patch(`/api/admin/bindings/${b.id}`, body); void reload(); } catch (e) { toast(e); }
  };
  const del = async (b: Binding) => { try { await api.del(`/api/admin/bindings/${b.id}`); void reload(); } catch (e) { toast(e); } };
  const add = async () => {
    const v = await form.validateFields();
    try {
      await api.post('/api/admin/bindings', { platformModelKey: pm.key, realModelId: v.realModelId, priority: v.priority, weight: v.weight });
      message.success('已添加');
      setAdding(false);
      form.resetFields();
      void reload();
    } catch (e) { toast(e); }
  };

  const bound = new Set(pm.bindings.map((b) => b.real_model_id));
  const options = models.filter((m) => m.enabled && !bound.has(m.id)).map((m) => ({ value: m.id, label: `${m.model_id} · ${m.channel_name}` }));

  return (
    <Card size="small" className="pm-card"
      title={<Space size={10}><span className="pm-key">{pm.key}</span><span>{pm.display_name}</span>{pm.enabled ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>}</Space>}
      extra={<Button size="small" icon={<PlusOutlined />} onClick={() => { form.setFieldsValue({ priority: 1, weight: 100 }); setAdding(true); }}>添加绑定</Button>}>
      <Table<Binding> rowKey="id" size="small" tableLayout="fixed" className="bind-table" dataSource={pm.bindings} pagination={false} locale={{ emptyText: '还没有绑定真实模型' }}
        columns={[
          { title: '真实模型', dataIndex: 'model_id', render: (v) => <span className="mono">{v}</span> },
          { title: '渠道', dataIndex: 'channel_name', width: 220, ellipsis: true },
          { title: '优先级', dataIndex: 'priority', width: 128, render: (v, r) => <InputNumber size="small" style={{ width: 96 }} min={1} max={100} defaultValue={v} onBlur={(e) => { const n = Number(e.target.value); if (n && n !== v) void patch(r, { priority: n }); }} /> },
          { title: '权重', dataIndex: 'weight', width: 128, render: (v, r) => <InputNumber size="small" style={{ width: 96 }} min={1} max={1000} defaultValue={v} onBlur={(e) => { const n = Number(e.target.value); if (n && n !== v) void patch(r, { weight: n }); }} /> },
          { title: '启用', dataIndex: 'enabled', width: 80, render: (v, r) => <Switch size="small" checked={v} onChange={(c) => patch(r, { enabled: c })} /> },
          { title: '', key: 'd', width: 72, align: 'right' as const, render: (_, r) => <Popconfirm title="删除绑定？" onConfirm={() => del(r)} okText="删除" cancelText="取消"><Button size="small" type="link" danger>删除</Button></Popconfirm> },
        ]} />
      <Modal title={`添加绑定 · ${pm.key}`} open={adding} onCancel={() => setAdding(false)} onOk={add} okText="添加" cancelText="取消" destroyOnHidden>
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="realModelId" label="真实模型（仅已启用）" rules={[{ required: true, message: '请选择模型' }]}>
            <Select options={options} showSearch optionFilterProp="label" notFoundContent="没有可绑定的已启用模型" />
          </Form.Item>
          <Space size={16}>
            <Form.Item name="priority" label="优先级"><InputNumber min={1} max={100} /></Form.Item>
            <Form.Item name="weight" label="权重"><InputNumber min={1} max={1000} /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </Card>
  );
}

export default function Routing() {
  const pms = useLoad<PM[]>('/api/admin/platform-models', undefined, []);
  const models = useLoad<RealModel[]>('/api/admin/models', undefined, []);
  const rules = useLoad<Rule[]>('/api/admin/rules', undefined, []);
  const [edit, setEdit] = useState<Rule | 'new' | null>(null);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const toast = useErrorToast();

  const pmOptions = (pms.data ?? []).map((p) => ({ value: p.key, label: `${p.key} · ${p.display_name}` }));

  const open = (r: Rule | 'new') => {
    setEdit(r);
    form.resetFields();
    if (r === 'new') form.setFieldsValue({ priority: 100, enabled: true, tags_any: [] });
    else form.setFieldsValue({
      name: r.name, priority: r.priority, enabled: r.enabled, primaryModel: r.primary_model, fallbackModel: r.fallback_model ?? undefined,
      quality: r.match?.quality, min_refs: r.match?.min_refs, max_refs: r.match?.max_refs, tags_any: r.match?.tags_any ?? [],
    });
  };

  const save = async () => {
    const v = await form.validateFields();
    const match: Rule['match'] = {};
    if (v.quality) match.quality = v.quality;
    if (v.min_refs !== undefined && v.min_refs !== null) match.min_refs = v.min_refs;
    if (v.max_refs !== undefined && v.max_refs !== null) match.max_refs = v.max_refs;
    if (v.tags_any?.length) match.tags_any = v.tags_any;
    const body = { name: v.name, priority: v.priority, match, primaryModel: v.primaryModel, fallbackModel: v.fallbackModel ?? null, enabled: !!v.enabled };
    try {
      if (edit === 'new') await api.post('/api/admin/rules', body);
      else if (edit) await api.put(`/api/admin/rules/${edit.id}`, body);
      message.success('已保存');
      setEdit(null);
      void rules.reload();
    } catch (e) { toast(e); }
  };

  const toggleRule = async (r: Rule, enabled: boolean) => {
    try {
      await api.put(`/api/admin/rules/${r.id}`, { name: r.name, priority: r.priority, match: r.match ?? {}, primaryModel: r.primary_model, fallbackModel: r.fallback_model, enabled });
      void rules.reload();
    } catch (e) { toast(e); }
  };
  const delRule = async (r: Rule) => { try { await api.del(`/api/admin/rules/${r.id}`); void rules.reload(); } catch (e) { toast(e); } };

  const matchText = (m: Rule['match']) => {
    const parts: string[] = [];
    if (m?.quality) parts.push(m.quality === 'hd' ? '高清' : '标准');
    if (m?.min_refs !== undefined) parts.push(`参考图 ≥ ${m.min_refs}`);
    if (m?.max_refs !== undefined) parts.push(`参考图 ≤ ${m.max_refs}`);
    if (m?.tags_any?.length) parts.push(`标签含 ${m.tags_any.map((t) => TAG_LABELS[t] ?? t).join('/')}`);
    return parts.length ? parts.join('，') : '全部（兜底）';
  };

  return (
    <>
      <div className="admin-hd"><h2>路由</h2><span className="muted">平台模型 → 真实模型绑定，以及按请求特征选择平台模型的规则</span></div>
      {(pms.data ?? []).map((pm) => <PlatformCard key={pm.key} pm={pm} models={models.data ?? []} reload={() => void pms.reload()} />)}

      <Card size="small" title="路由规则（按优先级从小到大匹配）" extra={<Button size="small" type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>新增规则</Button>}>
        <Table<Rule> rowKey="id" size="small" tableLayout="fixed" loading={rules.loading} dataSource={rules.data ?? []} pagination={false}
          columns={[
            { title: '优先级', dataIndex: 'priority', width: 80 },
            { title: '名称', dataIndex: 'name', width: 220, ellipsis: true },
            { title: '匹配条件', dataIndex: 'match', render: (m) => matchText(m) },
            { title: '首选', dataIndex: 'primary_model', width: 128, render: (v) => <span className="pm-key">{v}</span> },
            { title: '回退', dataIndex: 'fallback_model', width: 128, render: (v) => (v ? <span className="pm-key dim">{v}</span> : <span className="muted">—</span>) },
            { title: '启用', dataIndex: 'enabled', width: 80, render: (v, r) => <Switch size="small" checked={v} onChange={(c) => toggleRule(r, c)} /> },
            {
              title: '', key: 'a', width: 128, align: 'right' as const,
              render: (_, r) => (
                <Space size={0}>
                  <Button size="small" type="link" onClick={() => open(r)}>编辑</Button>
                  <Popconfirm title="删除规则？" onConfirm={() => delRule(r)} okText="删除" cancelText="取消"><Button size="small" type="link" danger>删除</Button></Popconfirm>
                </Space>
              ),
            },
          ]} />
      </Card>

      <Modal title={edit === 'new' ? '新增规则' : '编辑规则'} open={!!edit} onCancel={() => setEdit(null)} onOk={save} okText="保存" cancelText="取消" destroyOnHidden width={560}>
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]} style={{ width: 300 }}><Input maxLength={60} /></Form.Item>
            <Form.Item name="priority" label="优先级" rules={[{ required: true }]}><InputNumber min={1} max={1000} /></Form.Item>
            <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
          </Space>
          <div className="muted" style={{ marginBottom: 8 }}>匹配条件（留空表示不限）</div>
          <Space size={16} style={{ display: 'flex' }} align="start">
            <Form.Item name="quality" label="画质"><Select allowClear style={{ width: 120 }} options={[{ value: 'standard', label: '标准' }, { value: 'hd', label: '高清' }]} /></Form.Item>
            <Form.Item name="min_refs" label="最少参考图"><InputNumber min={0} max={10} /></Form.Item>
            <Form.Item name="max_refs" label="最多参考图"><InputNumber min={0} max={10} /></Form.Item>
          </Space>
          <Form.Item name="tags_any" label="标签包含任一">
            <Select mode="multiple" options={Object.entries(TAG_LABELS).map(([k, l]) => ({ value: k, label: l }))} />
          </Form.Item>
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="primaryModel" label="首选平台模型" rules={[{ required: true, message: '请选择' }]}><Select style={{ width: 220 }} options={pmOptions} /></Form.Item>
            <Form.Item name="fallbackModel" label="回退平台模型"><Select allowClear style={{ width: 220 }} options={pmOptions} /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}
