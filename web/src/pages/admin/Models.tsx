import { useState } from 'react';
import { App, Button, Form, InputNumber, Modal, Select, Switch, Table, Tag } from 'antd';
import { api } from '../../api/client';
import { useErrorToast } from '../../lib/notify';
import { useLoad } from './useLoad';

export interface RealModel {
  id: string; channel_id: string; channel_name: string; vendor: string; model_id: string; enabled: boolean;
  caps: { ratios?: string[]; hd?: boolean; max_refs?: number; edit?: boolean } | null;
  cost_standard_fen: number | string; cost_hd_fen: number | string;
}

const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2'];

export default function Models() {
  const { data, setData, loading, reload } = useLoad<RealModel[]>('/api/admin/models', undefined, []);
  const [edit, setEdit] = useState<RealModel | null>(null);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const toast = useErrorToast();

  const toggle = async (m: RealModel, enabled: boolean) => {
    setData((xs) => xs?.map((x) => (x.id === m.id ? { ...x, enabled } : x)));
    try { await api.patch(`/api/admin/models/${m.id}`, { enabled }); } catch (e) { toast(e); void reload(); }
  };

  const open = (m: RealModel) => {
    setEdit(m);
    form.setFieldsValue({
      ratios: m.caps?.ratios ?? [], hd: !!m.caps?.hd, max_refs: m.caps?.max_refs ?? 0, edit: !!m.caps?.edit,
      costStandardFen: Number(m.cost_standard_fen ?? 0), costHdFen: Number(m.cost_hd_fen ?? 0),
    });
  };
  const save = async () => {
    const v = await form.validateFields();
    try {
      await api.patch(`/api/admin/models/${edit!.id}`, {
        caps: { ratios: v.ratios, hd: v.hd, max_refs: v.max_refs, edit: v.edit },
        costStandardFen: v.costStandardFen, costHdFen: v.costHdFen,
      });
      message.success('已保存');
      setEdit(null);
      void reload();
    } catch (e) { toast(e); }
  };

  return (
    <>
      <div className="admin-hd"><h2>模型</h2><span className="muted">渠道同步得到的真实模型；新模型默认未启用</span></div>
      <Table<RealModel> rowKey="id" loading={loading} dataSource={data ?? []} pagination={false} scroll={{ x: 1000 }}
        columns={[
          { title: '启用', dataIndex: 'enabled', width: 70, render: (v, r) => <Switch size="small" checked={v} onChange={(c) => toggle(r, c)} /> },
          { title: '模型 ID', dataIndex: 'model_id', render: (v) => <span className="mono">{v}</span> },
          { title: '渠道', dataIndex: 'channel_name', render: (v, r) => (<span>{v} <Tag bordered={false}>{r.vendor}</Tag></span>) },
          { title: '比例', key: 'ratios', render: (_, r) => (r.caps?.ratios?.length ? r.caps.ratios.map((x) => <Tag key={x} bordered={false}>{x}</Tag>) : <span className="muted">—</span>) },
          { title: '高清', key: 'hd', width: 60, render: (_, r) => (r.caps?.hd ? '✓' : '—') },
          { title: '参考图', key: 'refs', width: 84, align: 'right', render: (_, r) => r.caps?.max_refs ?? 0 },
          { title: '编辑', key: 'edit', width: 60, render: (_, r) => (r.caps?.edit ? '✓' : '—') },
          { title: '成本(分) 标准/高清', key: 'cost', width: 150, align: 'right', render: (_, r) => `${Number(r.cost_standard_fen)} / ${Number(r.cost_hd_fen)}` },
          { title: '', key: 'a', width: 80, render: (_, r) => <Button size="small" type="link" onClick={() => open(r)}>能力与成本</Button> },
        ]} />

      <Modal title={`能力与成本 · ${edit?.model_id ?? ''}`} open={!!edit} onCancel={() => setEdit(null)} onOk={save} okText="保存" cancelText="取消" destroyOnHidden width={520}>
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="ratios" label="支持比例"><Select mode="multiple" options={RATIOS.map((r) => ({ value: r, label: r }))} /></Form.Item>
          <div style={{ display: 'flex', gap: 24 }}>
            <Form.Item name="hd" label="支持高清" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="edit" label="支持图生图/编辑" valuePropName="checked"><Switch /></Form.Item>
            <Form.Item name="max_refs" label="最多参考图"><InputNumber min={0} max={16} /></Form.Item>
          </div>
          <div style={{ display: 'flex', gap: 24 }}>
            <Form.Item name="costStandardFen" label="标准成本（分/张）"><InputNumber min={0} max={10000} step={0.1} /></Form.Item>
            <Form.Item name="costHdFen" label="高清成本（分/张）"><InputNumber min={0} max={10000} step={0.1} /></Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
}
