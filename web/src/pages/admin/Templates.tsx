import { useMemo, useState } from 'react';
import { App, Button, Col, Form, Input, InputNumber, Modal, Popconfirm, Row, Segmented, Select, Space, Switch, Table, Tag } from 'antd';
import { MinusCircleOutlined, PlusOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../../api/client';
import { TEMPLATE_CATEGORIES, TEMPLATE_PURPOSES, type AdminTemplate, type Mode, type Upload } from '../../api/types';
import { DETAILED_TAGS, MODE_LABELS, RATIO_OPTIONS, SIMPLE_TAGS, TAG_LABELS } from '../../lib/labels';
import { useErrorToast } from '../../lib/notify';
import UploadSlot from '../../components/UploadSlot';
import { useLoad } from './useLoad';

const tagOptions = (mode: Mode) => (mode === 'simple' ? SIMPLE_TAGS : DETAILED_TAGS).map((t) => ({ value: t, label: TAG_LABELS[t] ?? t }));
const ratioOptions = RATIO_OPTIONS.map((r) => ({ value: r.value, label: r.label ? `${r.value} ${r.label}` : r.value }));

export default function AdminTemplates() {
  const { data, setData, loading, reload } = useLoad<AdminTemplate[]>('/api/admin/templates', undefined, []);
  const [editing, setEditing] = useState<AdminTemplate | 'new' | null>(null);
  const [cover, setCover] = useState<Upload | null>(null);
  const [saving, setSaving] = useState(false);
  const [cat, setCat] = useState<string>('');
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const toast = useErrorToast();
  const mode = (Form.useWatch('mode', form) as Mode | undefined) ?? 'simple';

  const rows = useMemo(() => (data ?? []).filter((t) => !cat || t.category === cat), [data, cat]);

  const open = (t: AdminTemplate | 'new') => {
    setEditing(t);
    form.resetFields();
    if (t === 'new') {
      setCover(null);
      form.setFieldsValue({ category: TEMPLATE_CATEGORIES[0], mode: 'simple', prompt: '', tags: ['scene'], ratios: ['1:1'], quality: 'standard', sort: 0, enabled: true,
        purpose: '场景', descr: '', scenePrompt: '', allowText: false, fields: [], featured: false, source: '' });
    } else {
      setCover(t.thumb ? { id: t.coverAssetId, thumb: t.thumb, width: 0, height: 0 } : null);
      form.setFieldsValue({ title: t.title, category: t.category, mode: t.mode, prompt: t.prompt, tags: t.tags, ratios: t.ratios, quality: t.quality, sort: t.sort, enabled: t.enabled,
        purpose: t.purpose, descr: t.descr, scenePrompt: t.scenePrompt, allowText: t.allowText, fields: t.fields ?? [], featured: t.featured, source: t.source });
    }
  };

  const save = async () => {
    const v = await form.validateFields();
    if (!cover) { message.warning('请先上传封面图'); return; }
    const allowed = v.mode === 'simple' ? SIMPLE_TAGS : DETAILED_TAGS;
    const body = {
      title: v.title.trim(), category: v.category, mode: v.mode, coverAssetId: cover.id, prompt: (v.prompt ?? '').trim(),
      tags: (v.tags ?? []).filter((t: string) => allowed.includes(t)), ratios: v.ratios, quality: v.quality, sort: v.sort ?? 0, enabled: !!v.enabled,
      purpose: v.purpose ?? '场景', descr: (v.descr ?? '').trim(), scenePrompt: (v.scenePrompt ?? '').trim(), allowText: !!v.allowText,
      fields: (v.fields ?? []).filter((f: any) => f?.key && f?.label).map((f: any) => ({ key: f.key, label: f.label.trim(), placeholder: (f.placeholder ?? '').trim(), max: f.max ?? 16 })),
      featured: !!v.featured, source: (v.source ?? '').trim(),
    };
    setSaving(true);
    try {
      if (editing === 'new') await api.post('/api/admin/templates', body);
      else if (editing) await api.patch(`/api/admin/templates/${editing.id}`, body);
      message.success('已保存');
      setEditing(null);
      void reload();
    } catch (e) { toast(e); } finally { setSaving(false); }
  };

  const toggle = async (t: AdminTemplate, enabled: boolean) => {
    setData((xs) => (xs ?? []).map((x) => (x.id === t.id ? { ...x, enabled } : x)));
    try { await api.patch(`/api/admin/templates/${t.id}`, { enabled }); } catch (e) {
      setData((xs) => (xs ?? []).map((x) => (x.id === t.id ? { ...x, enabled: !enabled } : x)));
      toast(e);
    }
  };

  const del = async (t: AdminTemplate) => {
    try { await api.del(`/api/admin/templates/${t.id}`); message.success('已删除'); void reload(); } catch (e) { toast(e); }
  };

  return (
    <>
      <div className="admin-hd">
        <h2>灵感模板</h2>
        <span className="muted">{data?.length ? `${data.length} 个 · 启用 ${data.filter((t) => t.enabled).length}` : ''}</span>
        <div className="right">
          <Segmented value={cat} onChange={(v) => setCat(String(v))} options={[{ value: '', label: '全部' }, ...TEMPLATE_CATEGORIES.map((c) => ({ value: c, label: c }))]} />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => open('new')}>新建模板</Button>
        </div>
      </div>
      <Table<AdminTemplate> rowKey="id" loading={loading} dataSource={rows} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 1000 }}
        columns={[
          { title: '封面', dataIndex: 'thumb', width: 70, render: (v) => (safeUrl(v) ? <img src={safeUrl(v)} alt="" className="thumb-sm tall" /> : <div className="thumb-sm tall" />) },
          { title: '标题', dataIndex: 'title', render: (v, r) => (<div><div style={{ fontWeight: 500 }}>{v}</div><div className="muted ell-2" style={{ fontSize: 12, maxWidth: 280 }} title={r.prompt}>{r.descr || r.prompt || '（无描述）'}</div></div>) },
          { title: '用途', dataIndex: 'purpose', width: 70 },
          { title: '使用', dataIndex: 'uses', width: 64, align: 'right' },
          { title: '分类', dataIndex: 'category', width: 80, render: (v) => <Tag bordered={false}>{v}</Tag> },
          { title: '模式', dataIndex: 'mode', width: 80, render: (v: Mode) => <Tag color={v === 'detailed' ? 'blue' : 'green'} bordered={false}>{MODE_LABELS[v]}</Tag> },
          { title: '场景', dataIndex: 'tags', width: 170, render: (v: string[]) => (v?.length ? v.map((t) => TAG_LABELS[t] ?? t).join(' · ') : <span className="muted">—</span>) },
          { title: '尺寸', dataIndex: 'ratios', width: 120, render: (v: string[]) => <span className="mono">{v?.join(' ')}</span> },
          { title: '画质', dataIndex: 'quality', width: 64, render: (v) => (v === 'hd' ? '高清' : '标准') },
          { title: '排序', dataIndex: 'sort', width: 64, align: 'right' },
          { title: '启用', dataIndex: 'enabled', width: 70, render: (v, r) => <Switch size="small" checked={v} onChange={(c) => void toggle(r, c)} /> },
          {
            title: '操作', key: 'a', width: 120, fixed: 'right',
            render: (_, r) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => open(r)}>编辑</Button>
                <Popconfirm title="删除这个模板？" description="已经套用过的项目不受影响" onConfirm={() => del(r)} okText="删除" cancelText="取消" okButtonProps={{ danger: true }}>
                  <Button size="small" type="link" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]} />

      <Modal title={editing === 'new' ? '新建模板' : '编辑模板'} open={!!editing} onCancel={() => setEditing(null)} onOk={save} okText="保存" cancelText="取消"
        confirmLoading={saving} width={720} destroyOnHidden maskClosable={false}>
        <div className="tpl-form">
          <div className="tpl-form-cover">
            <div className="lbl"><span>封面图</span><span className="r">有内部场景时只作展示</span></div>
            <UploadSlot value={cover} onChange={setCover} endpoint="/api/admin/templates/cover" badge="封面" emptyTitle="上传封面" emptyHint="建议 3:4 · ≤15MB"
              style={{ height: 'auto', aspectRatio: '3 / 4' }} />
          </div>
          <Form form={form} layout="vertical" requiredMark={false} style={{ flex: 1, minWidth: 0 }}>
            <Row gutter={12}>
              <Col span={14}>
                <Form.Item name="title" label="标题" rules={[{ required: true, whitespace: true, message: '请填写标题' }, { max: 30 }]}><Input maxLength={30} /></Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item name="category" label="分类" rules={[{ required: true }]}><Select options={TEMPLATE_CATEGORIES.map((c) => ({ value: c, label: c }))} /></Form.Item>
              </Col>
              <Col span={14}>
                <Form.Item name="mode" label="模式" rules={[{ required: true }]}>
                  <Segmented block options={[{ value: 'simple', label: '简约' }, { value: 'detailed', label: '详细' }]}
                    onChange={(m) => {
                      const allowed = m === 'simple' ? SIMPLE_TAGS : DETAILED_TAGS;
                      form.setFieldValue('tags', ((form.getFieldValue('tags') as string[]) ?? []).filter((t) => allowed.includes(t)));
                    }} />
                </Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item name="quality" label="画质"><Segmented block options={[{ value: 'standard', label: '标准' }, { value: 'hd', label: '高清' }]} /></Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item name="prompt" label="描述" extra="用户套用后预填到「想要的效果」，可再修改" rules={[{ max: 500 }]}>
                  <Input.TextArea autoSize={{ minRows: 2, maxRows: 5 }} maxLength={500} showCount placeholder="比如：放在米色石材台面上，清晨暖光，高级感" />
                </Form.Item>
              </Col>
              <Col span={14}>
                <Form.Item name="tags" label="场景标签" rules={[{ type: 'array', max: 6, message: '最多 6 个' }]}>
                  <Select mode="multiple" options={tagOptions(mode)} placeholder="选择场景" maxCount={6} />
                </Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item name="ratios" label="尺寸" rules={[{ required: true, type: 'array', min: 1, message: '至少选择一个比例' }]}>
                  <Select mode="multiple" options={ratioOptions} maxCount={4} />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="purpose" label="用途"><Select options={TEMPLATE_PURPOSES.map((c) => ({ value: c, label: c }))} /></Form.Item>
              </Col>
              <Col span={16}>
                <Form.Item name="descr" label="一句话介绍" extra="显示在卡片标题下，40 字内" rules={[{ max: 40 }]}><Input maxLength={40} /></Form.Item>
              </Col>
              <Col span={24}>
                <Form.Item name="scenePrompt" label="内部场景（英文，用户不可见）" extra="填写后忽略场景标签和规划层；用 the product 指代用户商品；文字位用 {headline} {sub} {brand} {points}" rules={[{ max: 2500 }]}>
                  <Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} maxLength={2500} showCount />
                </Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="allowText" label="允许图上文字" valuePropName="checked"><Switch /></Form.Item>
              </Col>
              <Col span={8}>
                <Form.Item name="featured" label="首页置顶" valuePropName="checked"><Switch /></Form.Item>
              </Col>
              <Col span={24}>
                <div className="lbl" style={{ marginBottom: 8 }}><span>用户可填文字</span><span className="r">最多 3 个</span></div>
                <Form.List name="fields">
                  {(items, { add, remove }) => (
                    <>
                      {items.map(({ key, name }) => (
                        <Space key={key} align="baseline" style={{ display: 'flex' }}>
                          <Form.Item name={[name, 'key']} rules={[{ required: true }]}><Select style={{ width: 110 }} options={['brand', 'headline', 'sub', 'points'].map((k) => ({ value: k, label: k }))} /></Form.Item>
                          <Form.Item name={[name, 'label']} rules={[{ required: true, max: 10 }]}><Input placeholder="标签，如 主标题" maxLength={10} style={{ width: 120 }} /></Form.Item>
                          <Form.Item name={[name, 'placeholder']}><Input placeholder="示例" maxLength={30} style={{ width: 150 }} /></Form.Item>
                          <Form.Item name={[name, 'max']}><InputNumber min={2} max={40} placeholder="字数" style={{ width: 72 }} /></Form.Item>
                          <MinusCircleOutlined onClick={() => remove(name)} />
                        </Space>
                      ))}
                      {items.length < 3 && <Button type="dashed" size="small" onClick={() => add({ key: 'headline', label: '主标题', placeholder: '', max: 12 })} icon={<PlusOutlined />}>添加文字位</Button>}
                    </>
                  )}
                </Form.List>
              </Col>
              <Col span={24} style={{ marginTop: 16 }}>
                <Form.Item name="source" label="来源署名" rules={[{ max: 200 }]}><Input maxLength={200} placeholder="改编自…" /></Form.Item>
              </Col>
              <Col span={14}>
                <Form.Item name="sort" label="排序" extra="数字越小越靠前"><InputNumber min={-10000} max={10000} precision={0} style={{ width: '100%' }} /></Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item name="enabled" label="启用" valuePropName="checked"><Switch /></Form.Item>
              </Col>
            </Row>
          </Form>
        </div>
      </Modal>
    </>
  );
}
