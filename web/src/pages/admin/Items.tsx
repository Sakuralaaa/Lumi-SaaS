import { useState } from 'react';
import { Image, Select, Table, Tag, Tooltip } from 'antd';
import dayjs from 'dayjs';
import { safeUrl } from '../../api/client';
import { useLoad } from './useLoad';

interface Row {
  id: string; status: string; ratio: string; planned_model: string | null; used_model: string | null; used_quality: string | null;
  fallback: boolean; attempts: number; error_code: string | null; error_message: string | null; upstream_ms: number | null;
  cost_fen: number | string | null; credits: number; created_at: string; email: string; thumb: string | null;
}

const STATUS: Record<string, { label: string; color?: string }> = {
  succeeded: { label: '成功', color: 'success' }, failed: { label: '失败', color: 'error' },
  running: { label: '生成中', color: 'processing' }, queued: { label: '排队', color: 'default' },
};

export default function Items() {
  const [status, setStatus] = useState<string | undefined>();
  const { data, loading } = useLoad<Row[]>('/api/admin/items', { status }, []);

  return (
    <>
      <div className="admin-hd">
        <h2>生成记录</h2>
        <span className="muted">最近 200 条</span>
        <div className="right">
          <Select allowClear placeholder="全部状态" style={{ width: 140 }} value={status} onChange={setStatus}
            options={Object.entries(STATUS).map(([k, v]) => ({ value: k, label: v.label }))} />
        </div>
      </div>
      <Table<Row> rowKey="id" size="small" loading={loading} dataSource={data ?? []} pagination={{ pageSize: 30 }} scroll={{ x: 1300 }}
        columns={[
          { title: '', dataIndex: 'thumb', width: 60, render: (v) => { const u = safeUrl(v); return u ? <Image src={u} width={44} height={44} style={{ objectFit: 'cover', borderRadius: 2 }} /> : <div className="thumb-sm" />; } },
          { title: '时间', dataIndex: 'created_at', width: 110, render: (v) => dayjs(v).format('MM-DD HH:mm:ss') },
          { title: '用户', dataIndex: 'email', width: 180, ellipsis: true },
          { title: '状态', dataIndex: 'status', width: 80, render: (v) => <Tag color={STATUS[v]?.color}>{STATUS[v]?.label ?? v}</Tag> },
          { title: '比例', dataIndex: 'ratio', width: 60 },
          { title: '画质', dataIndex: 'used_quality', width: 60, render: (v) => (v === 'hd' ? '高清' : v === 'standard' ? '标准' : '—') },
          { title: '计划 → 实际模型', key: 'm', width: 220, render: (_, r) => (<span className="mono">{r.planned_model ?? '—'} → {r.used_model ?? '—'}{r.fallback && <Tag color="warning" style={{ marginLeft: 6 }}>回退</Tag>}</span>) },
          { title: '尝试', dataIndex: 'attempts', width: 60, align: 'right' },
          { title: '耗时', dataIndex: 'upstream_ms', width: 80, align: 'right', render: (v) => (v ? `${(v / 1000).toFixed(1)}s` : '—') },
          { title: '成本(分)', dataIndex: 'cost_fen', width: 80, align: 'right', render: (v) => (v === null || v === undefined ? '—' : Number(v)) },
          { title: '积分', dataIndex: 'credits', width: 60, align: 'right' },
          {
            title: '错误', key: 'err', ellipsis: true,
            render: (_, r) => (r.error_code || r.error_message ? (
              <Tooltip title={r.error_message ?? ''}><span><Tag color="error" bordered={false}>{r.error_code ?? 'error'}</Tag><span className="muted">{r.error_message ?? ''}</span></span></Tooltip>
            ) : '—'),
          },
        ]} />
    </>
  );
}
