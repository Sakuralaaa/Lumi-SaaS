import { useEffect, useState } from 'react';
import { Drawer, Table, Tag } from 'antd';
import dayjs from 'dayjs';
import { api } from '../api/client';
import type { LedgerRow } from '../api/types';
import { LEDGER_REASONS } from '../lib/labels';
import { useAuth } from '../lib/auth';
import { useErrorToast } from '../lib/notify';

export function LedgerTable({ rows, loading }: { rows: LedgerRow[]; loading: boolean }) {
  return (
    <Table<LedgerRow>
      size="small"
      rowKey={(r) => String(r.id ?? `${r.created_at}|${r.delta}|${r.balance_after}`)}
      loading={loading}
      dataSource={rows}
      pagination={{ pageSize: 20, hideOnSinglePage: true, size: 'small' }}
      columns={[
        { title: '时间', dataIndex: 'created_at', width: 140, render: (v: string) => dayjs(v).format('MM-DD HH:mm') },
        { title: '类型', dataIndex: 'reason', render: (v: string) => <Tag bordered={false}>{LEDGER_REASONS[v] ?? v}</Tag> },
        {
          title: '变动', dataIndex: 'delta', align: 'right',
          render: (v: number) => <span style={{ color: v > 0 ? 'var(--accent)' : 'var(--ink)', fontWeight: 600 }}>{v > 0 ? `+${v}` : v}</span>,
        },
        { title: '余额', dataIndex: 'balance_after', align: 'right' },
      ]}
    />
  );
}

export default function LedgerDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [loading, setLoading] = useState(false);
  const { user, refresh } = useAuth();
  const toast = useErrorToast();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    void refresh();
    api.get<LedgerRow[]>('/api/credits/ledger').then(setRows).catch(toast).finally(() => setLoading(false));
  }, [open, refresh, toast]);

  return (
    <Drawer title="积分明细" open={open} onClose={onClose} width={480}>
      <div className="stat" style={{ marginBottom: 16 }}>
        <span>当前余额</span>
        <b>{(user?.credits ?? 0).toLocaleString('zh-CN')} <small>积分</small></b>
      </div>
      <LedgerTable rows={rows} loading={loading} />
    </Drawer>
  );
}
