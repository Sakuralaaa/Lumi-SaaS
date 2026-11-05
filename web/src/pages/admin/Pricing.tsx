import { useEffect, useMemo, useState } from 'react';
import { Alert, App, AutoComplete, Button, Card, Col, Form, InputNumber, Row, Select, Switch, Table, Tag } from 'antd';
import { api } from '../../api/client';
import type { AdminSettings, ChannelModels } from '../../api/types';
import { useErrorToast } from '../../lib/notify';
import { useLoad } from './useLoad';

interface RealModel { id: string; model_id: string; channel_name: string; enabled: boolean; caps: { hd?: boolean }; cost_standard_fen: number; cost_hd_fen: number }

function MarginTag({ price, costFen }: { price?: number; costFen: number }) {
  if (!price) return <span className="muted">—</span>;
  const m = 1 - costFen / (price * 10);
  const color = m < 0 ? 'red' : m < 0.3 ? 'orange' : 'green';
  return <Tag color={color}>{(m * 100).toFixed(0)}%</Tag>;
}

type PricingResp = { standard: number; hd: number } | { quality: string; credits: number }[];
type Settings = AdminSettings;
interface Ch { id: string; name: string; vendor: string; status: 'active' | 'disabled'; purpose?: 'image' | 'chat' }
const PLANNER_KEYS = ['planner_enabled', 'planner_channel_id', 'planner_model'] as const;

const NUM_FIELDS: { key: keyof Settings; label: string; extra?: string; min?: number; max?: number }[] = [
  { key: 'concurrency_user', label: '单用户并发', min: 1, max: 50 },
  { key: 'concurrency_global', label: '全局并发', min: 1, max: 1000 },
  { key: 'beta_default_credits', label: '默认赠送积分', extra: '邀请码未设置积分时使用', min: 0 },
  { key: 'beta_daily_image_limit', label: '每日出图上限', extra: '新用户默认值，可在用户页单独调整', min: 0 },
  { key: 'max_images_per_job', label: '单次最多张数', min: 1, max: 16 },
];
const BOOL_FIELDS: { key: keyof Settings; label: string; extra?: string }[] = [
  { key: 'signup_enabled', label: '开放注册', extra: '关闭后暂停所有注册，邀请码也无法使用' },
  { key: 'mix_batch_enabled', label: '同批混合模型', extra: '标准画质且参考图 ≤3 时，一批内分配给多个模型' },
  { key: 'feature_user_referral', label: '用户邀请（实验）', extra: '允许普通用户生成邀请码' },
];

function normPricing(p?: PricingResp) {
  if (!p) return undefined;
  if (Array.isArray(p)) {
    const o: Record<string, number> = {};
    for (const r of p) o[r.quality] = Number(r.credits);
    return { standard: o.standard, hd: o.hd };
  }
  return p;
}

export default function Pricing() {
  const pricing = useLoad<PricingResp>('/api/admin/pricing');
  const models = useLoad<RealModel[]>('/api/admin/models');
  const settings = useLoad<Settings>('/api/admin/settings');
  const [pf] = Form.useForm();
  const [sf] = Form.useForm();
  const [plf] = Form.useForm();
  const channels = useLoad<Ch[]>('/api/admin/channels', undefined, []);
  const [chModels, setChModels] = useState<{ id: string; data: ChannelModels | null; loading: boolean; error: string | null } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { message } = App.useApp();
  const toast = useErrorToast();

  useEffect(() => { const p = normPricing(pricing.data); if (p) pf.setFieldsValue(p); }, [pricing.data, pf]);
  useEffect(() => {
    if (!settings.data) return;
    const { planner_enabled, planner_channel_id, planner_model, ...rest } = settings.data;
    sf.setFieldsValue(rest);
    // empty strings mean "not configured": show the selects empty rather than preselecting anything
    plf.setFieldsValue({ planner_enabled, planner_channel_id: planner_channel_id || undefined, planner_model: planner_model || undefined });
  }, [settings.data, sf, plf]);

  const plChannel = Form.useWatch('planner_channel_id', plf) as string | undefined;
  const plModel = Form.useWatch('planner_model', plf) as string | undefined;
  const plEnabled = Form.useWatch('planner_enabled', plf) as boolean | undefined;

  // live model list of the chosen channel (GET /v1/models through the backend)
  useEffect(() => {
    if (!plChannel) { setChModels(null); return; }
    let stop = false;
    setChModels({ id: plChannel, data: null, loading: true, error: null });
    api.get<ChannelModels>(`/api/admin/channels/${plChannel}/models`)
      .then((d) => { if (!stop) setChModels({ id: plChannel, data: d, loading: false, error: null }); })
      .catch((e) => { if (!stop) setChModels({ id: plChannel, data: null, loading: false, error: e?.message || '获取模型失败' }); });
    return () => { stop = true; };
  }, [plChannel]);

  const channelOptions = useMemo(() => {
    const list = [...(channels.data ?? [])];
    // prefer chat-purpose channels when the backend reports a purpose
    list.sort((a, b) => Number(b.purpose === 'chat') - Number(a.purpose === 'chat'));
    return list.map((c) => ({
      value: c.id,
      label: (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span>{c.name}</span>
          {c.purpose === 'chat' && <Tag color="blue" bordered={false} style={{ marginInlineEnd: 0 }}>对话</Tag>}
          {c.purpose === 'image' && <Tag bordered={false} style={{ marginInlineEnd: 0 }}>图片</Tag>}
          {c.status !== 'active' && <span className="muted">（停用）</span>}
        </span>
      ),
      search: c.name,
    }));
  }, [channels.data]);

  const modelOptions = useMemo(() => {
    const d = chModels?.data;
    if (!d) return [];
    const ids = d.chat.length ? d.chat : d.all;
    const q = (plModel ?? '').toLowerCase();
    return ids.filter((x) => !q || x.toLowerCase().includes(q)).slice(0, 200).map((x) => ({ value: x }));
  }, [chModels, plModel]);

  const savePlanner = async () => {
    const v = await plf.validateFields();
    setBusy('pl');
    try {
      const r = await api.put<Settings>('/api/admin/settings', {
        planner_enabled: !!v.planner_enabled,
        planner_channel_id: v.planner_channel_id ?? '',
        planner_model: (v.planner_model ?? '').trim(),
      });
      settings.setData(r);
      message.success('规划模型设置已保存');
    } catch (e) { toast(e); } finally { setBusy(null); }
  };
  const plannerUnset = !plChannel || !(plModel ?? '').trim();

  const savePricing = async () => {
    const v = await pf.validateFields();
    setBusy('p');
    try { await api.put('/api/admin/pricing', { standard: v.standard, hd: v.hd }); message.success('定价已保存'); } catch (e) { toast(e); } finally { setBusy(null); }
  };
  const saveSettings = async () => {
    const v = await sf.validateFields();
    setBusy('s');
    try {
      const r = await api.put<Settings>('/api/admin/settings', v);
      const rest: Partial<Settings> = { ...r };
      for (const k of PLANNER_KEYS) delete rest[k];
      sf.setFieldsValue(rest);
      message.success('设置已保存');
    } catch (e) { toast(e); } finally { setBusy(null); }
  };

  const std = Form.useWatch('standard', pf);
  const hd = Form.useWatch('hd', pf);

  return (
    <>
      <div className="admin-hd"><h2>定价与设置</h2></div>
      <Row gutter={[16, 16]} className="eq-row">
        <Col xs={24} lg={9}>
          <Card size="small" title="定价（积分/张）" loading={pricing.loading && !pricing.data}
            extra={<Button type="primary" size="small" onClick={savePricing} loading={busy === 'p'}>保存</Button>}>
            <Form form={pf} layout="vertical">
              <Row gutter={16}><Col span={12}>
              <Form.Item name="standard" label="标准" rules={[{ required: true }]} extra={std ? `≈ ¥${(std / 10).toFixed(2)} / 张` : undefined}>
                <InputNumber min={1} max={1000} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              </Col><Col span={12}>
              <Form.Item name="hd" label="高清" rules={[{ required: true }]} extra={hd ? `≈ ¥${(hd / 10).toFixed(2)} / 张` : undefined}>
                <InputNumber min={1} max={1000} precision={0} style={{ width: '100%' }} />
              </Form.Item>
              </Col></Row>
            </Form>
            <div className="muted">1 积分 = ¥0.10。改价立即对新任务生效，已提交的任务按提交时价格结算和退款。</div>
          </Card>
        </Col>
        <Col xs={24} lg={15}>
          <Card size="small" title="毛利预估" 
            extra={<span className="muted">按当前输入实时计算 · 成本在「模型」页改</span>}>
            <Table<RealModel> size="small" tableLayout="fixed" pagination={false} rowKey="id" loading={models.loading && !models.data}
              dataSource={(models.data ?? []).filter((m) => m.enabled)}
              columns={[
                { title: '模型', dataIndex: 'model_id', ellipsis: true, render: (v, r) => <span title={r.channel_name}>{v}</span> },
                { title: '标准 成本/毛利', render: (_, r) => <span>¥{(r.cost_standard_fen / 100).toFixed(2)} <MarginTag price={std} costFen={r.cost_standard_fen} /></span> },
                { title: '高清 成本/毛利', render: (_, r) => r.caps?.hd
                    ? <span>¥{(r.cost_hd_fen / 100).toFixed(2)} <MarginTag price={hd} costFen={r.cost_hd_fen} /></span>
                    : <span className="muted">不支持</span> },
              ]} />
            <div className="muted" style={{ marginTop: 8 }}>毛利 = 1 − 成本 ÷ 售价；绿 ≥30%，橙 0–30%，红 = 亏本。未含重试、存储和流量。</div>
          </Card>
        </Col>
        <Col xs={24} lg={14}>
          <Card size="small" title="系统设置" loading={settings.loading && !settings.data}
            extra={<Button type="primary" size="small" onClick={saveSettings} loading={busy === 's'}>保存</Button>}>
            <Form form={sf} layout="vertical">
              <div className="set-label">额度与并发</div>
              <Row gutter={16}>
                {NUM_FIELDS.map((f) => (
                  <Col span={8} key={f.key}>
                    <Form.Item name={f.key} label={f.label} tooltip={f.extra} rules={[{ required: true }]}>
                      <InputNumber min={f.min ?? 0} max={f.max ?? 100000} precision={0} style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                ))}
              </Row>
              <div className="set-label">功能开关</div>
              <div className="set-list">
                {BOOL_FIELDS.map((f) => (
                  <div className="set-row" key={f.key}>
                    <div><div className="set-row-t">{f.label}</div>{f.extra && <div className="set-row-d">{f.extra}</div>}</div>
                    <Form.Item name={f.key} valuePropName="checked" noStyle><Switch /></Form.Item>
                  </div>
                ))}
              </div>
            </Form>
          </Card>
        </Col>
        <Col xs={24} lg={10}>
          <Card size="small" title="规划模型" loading={settings.loading && !settings.data}
            extra={<Button type="primary" size="small" onClick={savePlanner} loading={busy === 'pl'}>保存</Button>}>
            {plannerUnset && (
              <Alert type="info" showIcon className="soft-alert" style={{ marginBottom: 14 }} message="未配置规划模型，当前使用模板提示词" />
            )}
            <Form form={plf} layout="vertical">
              <Row gutter={16}>
                <Col span={24}>
                  <Form.Item name="planner_enabled" label="启用规划" valuePropName="checked" style={{ marginBottom: 12 }}
                    extra="开启后先由对话模型理解商品图并改写出图提示词；渠道或模型为空时自动跳过">
                    <Switch />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item name="planner_channel_id" label="规划渠道" extra="需单独接入支持对话的上游；图片中转渠道不能用于规划">
                    <Select allowClear placeholder="选择渠道" options={channelOptions} loading={channels.loading}
                      showSearch optionFilterProp="search" disabled={plEnabled === false}
                      onChange={() => plf.setFieldValue('planner_model', undefined)}
                      notFoundContent={<span className="muted">还没有渠道，请先到「上游渠道」新增</span>} />
                  </Form.Item>
                </Col>
                <Col span={24}>
                  <Form.Item name="planner_model" label="规划模型"
                    rules={[{ pattern: /^[A-Za-z0-9._:/@-]*$/, message: '模型名只能包含字母数字和 ._:/@-' }, { max: 120 }]}
                    extra={chModels?.error ? <span style={{ color: '#c0563b' }}>{chModels.error}，可手动填写模型名</span>
                      : chModels?.data && !chModels.data.chat.length ? '该渠道没有识别到对话模型，已列出全部模型' : undefined}>
                    <AutoComplete allowClear options={modelOptions} disabled={!plChannel || plEnabled === false}
                      placeholder={!plChannel ? '先选择渠道' : chModels?.loading ? '正在获取模型列表…' : '选择或输入模型名'} />
                  </Form.Item>
                </Col>
              </Row>
            </Form>
          </Card>
        </Col>
      </Row>
    </>
  );
}
