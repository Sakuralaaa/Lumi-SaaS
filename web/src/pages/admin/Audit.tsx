import { Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { useLoad } from './useLoad';

interface Row {
  id: number; actor_id: string | null; actor_email: string | null; action: string; target_type: string | null; target_id: string | null;
  ip: string | null; meta: unknown; created_at: string;
}

export default function Audit() {
  const { data, loading } = useLoad<Row[]>('/api/admin/audit', undefined, []);
  return (
    <>
      <div className="admin-hd"><h2>审计日志</h2><span className="muted">最近 300 条</span></div>
      <Table<Row> rowKey="id" size="small" loading={loading} dataSource={data ?? []} pagination={{ pageSize: 30 }} scroll={{ x: 1100 }}
        columns={[
          { title: '时间', dataIndex: 'created_at', width: 150, render: (v) => dayjs(v).format('YYYY-MM-DD HH:mm:ss') },
          { title: '操作人', dataIndex: 'actor_email', width: 200, ellipsis: true, render: (v) => v ?? <span className="muted">—</span> },
          { title: '动作', dataIndex: 'action', width: 190, render: (v) => <Tag bordered={false} color={String(v).includes('failed') ? 'error' : undefined}>{v}</Tag> },
          { title: '对象', key: 't', width: 220, render: (_, r) => (r.target_type ? <span className="mono">{r.target_type}{r.target_id ? `:${r.target_id.slice(0, 8)}` : ''}</span> : '—') },
          { title: 'IP', dataIndex: 'ip', width: 120, render: (v) => <span className="mono">{v ?? '—'}</span> },
          { title: '详情', dataIndex: 'meta', render: (v) => (v ? <div className="meta-json">{typeof v === 'string' ? v : JSON.stringify(v)}</div> : '—') },
        ]} />
    </>
  );
}
