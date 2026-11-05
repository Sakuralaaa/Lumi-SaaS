import { useMemo, useState } from 'react';
import { Card, Segmented, Table, Tooltip } from 'antd';
import { useLoad, fen2yuan } from './useLoad';

interface Stats {
  daily: { day: string; images: number; failed: number; credits: number; cost_fen: number }[];
  byModel: { model: string | null; ok: number; failed: number; avg_ms: number | null; fallbacks: number }[];
  prefs: { model: string | null; action: string; n: number }[];
  totals: { users: number; active7: number; in_flight: number };
}

const ACTIONS: Record<string, string> = { favorite: '收藏', unfavorite: '取消收藏', delete: '删除', download: '下载' };
const margin = (credits: number, cost: number) => {
  const rev = credits * 10;
  if (!rev) return '—';
  return `${((1 - cost / rev) * 100).toFixed(1)}%`;
};

export default function Overview() {
  const [days, setDays] = useState(14);
  const { data: raw, loading } = useLoad<Stats>('/api/admin/stats', { days });
  // the API only returns days that had items; fill the whole window with zeros so the chart has a time axis
  const data = useMemo(() => {
    if (!raw) return raw;
    const by = new Map(raw.daily.map((r) => [r.day, r]));
    const daily: Stats['daily'] = [];
    // server buckets by Asia/Shanghai calendar day, so build the axis in that zone regardless of the browser's
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    for (let i = days - 1; i >= 0; i--) {
      const day = fmt.format(new Date(Date.now() - i * 86400_000));
      daily.push(by.get(day) ?? { day, images: 0, failed: 0, credits: 0, cost_fen: 0 });
    }
    return { ...raw, daily };
  }, [raw, days]);

  const sum = useMemo(() => {
    const d = data?.daily ?? [];
    return d.reduce((a, r) => ({ images: a.images + r.images, failed: a.failed + r.failed, credits: a.credits + r.credits, cost: a.cost + Number(r.cost_fen || 0) }),
      { images: 0, failed: 0, credits: 0, cost: 0 });
  }, [data]);
  const maxImg = Math.max(1, ...(data?.daily ?? []).map((r) => r.images + r.failed));

  // prefs pivot: model × action
  const prefRows = useMemo(() => {
    const m = new Map<string, Record<string, number | string>>();
    for (const p of data?.prefs ?? []) {
      const k = p.model ?? '—';
      if (!m.has(k)) m.set(k, { model: k });
      m.get(k)![p.action] = p.n;
    }
    return [...m.values()];
  }, [data]);

  return (
    <>
      <div className="admin-hd">
        <h2>概览</h2>
        <div className="right">
          <Segmented value={days} onChange={(v) => setDays(Number(v))} options={[{ value: 7, label: '7 天' }, { value: 14, label: '14 天' }, { value: 30, label: '30 天' }]} />
        </div>
      </div>
      <div className="stat-grid">
        <div className="stat"><span>用户总数</span><b>{data?.totals.users ?? '—'}</b></div>
        <div className="stat"><span>7 日活跃</span><b>{data?.totals.active7 ?? '—'}</b></div>
        <div className="stat"><span>进行中任务</span><b>{data?.totals.in_flight ?? '—'}</b></div>
        <div className="stat">
          <span>{days} 日出图 · 毛利</span>
          <b>{sum.images.toLocaleString('zh-CN')} <small>张 · {margin(sum.credits, sum.cost)}</small></b>
        </div>
      </div>

      <Card title="每日出图" size="small" style={{ marginBottom: 16 }} loading={loading && !data}
        extra={<span className="muted">收入 ¥{(sum.credits / 10).toFixed(2)} · 成本 {fen2yuan(sum.cost)} · 失败 {sum.failed}</span>}>
        {data?.daily.length ? (
          <div className="bars">
            {data.daily.map((r) => (
              <Tooltip key={r.day} title={`${r.day}：成功 ${r.images}，失败 ${r.failed}`}>
                <div className="b">
                  <em>{r.images || ''}</em>
                  <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', height: `${((r.images + r.failed) / maxImg) * 100}%`, minHeight: 2 }}>
                    {r.failed > 0 && <i className="f" style={{ height: `${(r.failed / (r.images + r.failed)) * 100}%` }} />}
                    <i style={{ flex: 1 }} />
                  </div>
                  <small>{r.day.slice(5)}</small>
                </div>
              </Tooltip>
            ))}
          </div>
        ) : <div className="muted" style={{ padding: 20, textAlign: 'center' }}>暂无数据</div>}
      </Card>

      <Card title="每日明细" size="small" style={{ marginBottom: 16 }}>
        <Table size="small" rowKey="day" loading={loading} dataSource={[...(data?.daily ?? [])].filter((r) => r.images || r.failed).reverse()} pagination={false}
          columns={[
            { title: '日期', dataIndex: 'day' },
            { title: '成功', dataIndex: 'images', align: 'right' },
            { title: '失败', dataIndex: 'failed', align: 'right' },
            { title: '积分', dataIndex: 'credits', align: 'right' },
            { title: '收入', align: 'right', render: (_, r) => `¥${(r.credits / 10).toFixed(2)}` },
            { title: '成本', dataIndex: 'cost_fen', align: 'right', render: (v: number) => fen2yuan(v) },
            { title: '毛利率', align: 'right', render: (_, r) => margin(r.credits, Number(r.cost_fen)) },
          ]} />
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <Card title="按模型" size="small">
          <Table size="small" rowKey={(r) => r.model ?? '—'} loading={loading} dataSource={data?.byModel ?? []} pagination={false}
            columns={[
              { title: '模型', dataIndex: 'model', render: (v) => <span className="mono">{v ?? '—'}</span> },
              { title: '成功', dataIndex: 'ok', align: 'right' },
              { title: '失败', dataIndex: 'failed', align: 'right' },
              { title: '成功率', align: 'right', render: (_, r) => (r.ok + r.failed ? `${((r.ok / (r.ok + r.failed)) * 100).toFixed(0)}%` : '—') },
              { title: '平均耗时', dataIndex: 'avg_ms', align: 'right', render: (v) => (v ? `${(v / 1000).toFixed(1)}s` : '—') },
              { title: '回退', dataIndex: 'fallbacks', align: 'right' },
            ]} />
        </Card>
        <Card title="用户偏好" size="small">
          <Table size="small" rowKey={(r) => String(r.model)} loading={loading} dataSource={prefRows} pagination={false}
            columns={[
              { title: '模型', dataIndex: 'model', render: (v) => <span className="mono">{String(v)}</span> },
              ...Object.entries(ACTIONS).map(([k, label]) => ({ title: label, dataIndex: k, align: 'right' as const, render: (v: unknown) => (v as number) ?? 0 })),
            ]} />
        </Card>
      </div>
    </>
  );
}
