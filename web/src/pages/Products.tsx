import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App, Button, Checkbox, Input, Modal, Segmented, Spin } from 'antd';
import { AppstoreAddOutlined, DeleteOutlined, EditOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import type { Product, Quality } from '../api/types';
import { useErrorToast } from '../lib/notify';
import { useOptions, useProjects } from '../lib/projects';
import { useAuth } from '../lib/auth';
import { SIMPLE_PACKS, TAG_LABELS, shotText } from '../lib/labels';
import { newUuid } from '../lib/id';
import dayjs from 'dayjs';

export default function Products() {
  const [list, setList] = useState<Product[] | null>(null);
  const [editing, setEditing] = useState<Product | null>(null);
  const [name, setName] = useState('');
  const [points, setPoints] = useState('');
  const [busy, setBusy] = useState(false);
  const { modal, message } = App.useApp();
  const toast = useErrorToast();
  const [picked, setPicked] = useState<string[]>([]);
  const [batchOpen, setBatchOpen] = useState(false);
  const togglePick = (id: string) => setPicked((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 10 ? s : [...s, id]));

  useEffect(() => { api.get<Product[]>('/api/products').then(setList).catch((e) => { toast(e); setList([]); }); }, [toast]);

  const open = (p: Product) => { setEditing(p); setName(p.name); setPoints(p.points.join('\n')); };
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      const r = await api.patch<Product>(`/api/products/${editing.id}`, { name: name.trim(), points: points.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5) });
      setList((l) => (l ?? []).map((x) => (x.id === r.id ? r : x)));
      setEditing(null);
    } catch (e) { toast(e); } finally { setBusy(false); }
  };
  const remove = (p: Product) => modal.confirm({
    title: `删除商品「${p.name}」？`, content: '只从商品库移除，已生成的作品不受影响。',
    okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
    onOk: async () => { try { await api.del(`/api/products/${p.id}`); setList((l) => (l ?? []).filter((x) => x.id !== p.id)); message.success('已删除'); } catch (e) { toast(e); } },
  });

  return (
    <div className="page">
      <div className="page-hd">
        <h2>商品库</h2>
        <span>{list?.length ? `${list.length} 个商品` : ''}</span>
        {!!list?.length && (
          <div className="page-hd-r">
            {picked.length > 0 && <button type="button" className="lnk" onClick={() => setPicked([])}>取消选择</button>}
            <Button type="primary" icon={<AppstoreAddOutlined />} disabled={!picked.length} onClick={() => setBatchOpen(true)}>
              {picked.length ? `批量出图 · ${picked.length} 个商品` : '勾选商品批量出图'}
            </Button>
          </div>
        )}
      </div>
      {!list ? <div className="empty-state" style={{ height: 300 }}><Spin /></div> : !list.length ? (
        <div className="empty-state" style={{ height: 420 }}>
          <h3>还没有商品</h3>
          <p>在项目里上传商品图、填好名称和卖点后点「存入」，商品就会留在这里，不会过期，下次直接选用。</p>
        </div>
      ) : (
        <div className="prod-grid">
          {list.map((p) => (
            <div key={p.id} className={`prod-card${picked.includes(p.id) ? ' on' : ''}`}>
              <Checkbox className="prod-pick" checked={picked.includes(p.id)} onChange={() => togglePick(p.id)} aria-label="选择这个商品" />
              <div className="prod-imgs">
                {p.images.slice(0, 3).map((im) => safeUrl(im.thumb) ? <img key={im.id} src={safeUrl(im.thumb)} alt="" /> : null)}
              </div>
              <div className="prod-tx">
                <b>{p.name}</b>
                <small>{p.points.length ? p.points.join(' · ') : '未填写卖点'}</small>
              </div>
              <div className="prod-act">
                <button type="button" onClick={() => open(p)} aria-label="编辑"><EditOutlined /></button>
                <button type="button" className="danger" onClick={() => remove(p)} aria-label="删除"><DeleteOutlined /></button>
              </div>
            </div>
          ))}
        </div>
      )}
      <BatchModal open={batchOpen} onClose={() => setBatchOpen(false)} products={(list ?? []).filter((p) => picked.includes(p.id))} />
      <Modal title="编辑商品" open={!!editing} onCancel={() => setEditing(null)} onOk={save} okText="保存" cancelText="取消" confirmLoading={busy} width={420} destroyOnHidden>
        <div className="facts" style={{ marginTop: 8 }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} placeholder="商品名称" />
          <Input.TextArea value={points} onChange={(e) => setPoints(e.target.value)} autoSize={{ minRows: 4, maxRows: 6 }} placeholder="每行一条卖点，最多 5 条，每条 24 字以内" />
        </div>
      </Modal>
    </div>
  );
}

/** Same set of images for several products at once: one project, one batch per product. */
function BatchModal({ open, onClose, products }: { open: boolean; onClose: () => void; products: Product[] }) {
  const opts = useOptions();
  const { user, setCredits } = useAuth();
  const { reload } = useProjects();
  const { message } = App.useApp();
  const toast = useErrorToast();
  const nav = useNavigate();
  const [pack, setPack] = useState(SIMPLE_PACKS[0].key);
  const [quality, setQuality] = useState<Quality>('standard');
  const [busy, setBusy] = useState(false);
  const p = SIMPLE_PACKS.find((x) => x.key === pack) ?? SIMPLE_PACKS[0];
  const usable = products.filter((x) => x.images.length);
  const cost = (opts.prices[quality] ?? 0) * p.rows.length * usable.length;
  const go = async () => {
    if (!usable.length) return;
    setBusy(true);
    try {
      const proj = await api.post<{ id: string }>('/api/projects', { name: `批量出图 · ${p.label} · ${dayjs().format('MM-DD HH:mm')}`, mode: 'simple' });
      const seen: Record<string, number> = {};
      const rows = p.rows.map(([tag, ratio]) => { const n = (seen[tag] = (seen[tag] ?? -1) + 1); return { tag, ratio, text: shotText(tag, n) }; });
      let ok = 0; let spent = 0;
      for (const pr of usable) {
        try {
          const r = await api.post<{ reserved: number }>('/api/jobs', {
            projectId: proj.id, prompt: '', tags: [], quality, rows, inputs: [{ assetId: pr.images[0].id, role: 'product' }],
            facts: { name: pr.name, points: pr.points },
          }, { headers: { 'Idempotency-Key': newUuid() } });
          ok++; spent += r.reserved;
        } catch (e) { toast(e); break; }
      }
      if (user) setCredits(Math.max(0, user.credits - spent));
      await reload();
      if (ok) { message.success(`已开始为 ${ok} 个商品出图`); onClose(); nav(`/p/${proj.id}`); }
    } catch (e) { toast(e); } finally { setBusy(false); }
  };
  return (
    <Modal open={open} onCancel={onClose} title={`批量出图 · ${usable.length} 个商品`} width={560} centered destroyOnHidden
      okText={`开始 · ${cost} 积分`} cancelText="取消" onOk={go} confirmLoading={busy} okButtonProps={{ disabled: !usable.length || cost > (user?.credits ?? 0) }}>
      <p className="muted-p">每个商品都按同一套餐出图，卖点用商品库里填好的。会新建一个项目放这些结果。</p>
      <div className="packs" style={{ marginBottom: 12 }}>
        {SIMPLE_PACKS.map((x) => (
          <button key={x.key} type="button" className={x.key === pack ? 'on' : ''} onClick={() => setPack(x.key)}>{x.label}<small>{x.rows.length} 张</small></button>
        ))}
      </div>
      <p className="muted-p">{p.rows.map(([t, r]) => `${TAG_LABELS[t]} ${r}`).join(' · ')}</p>
      <div className="line" style={{ marginTop: 12 }}>
        <span>画质</span>
        <Segmented size="small" value={quality} onChange={(v) => setQuality(v as Quality)} options={[{ value: 'standard', label: '标准' }, { value: 'hd', label: '高清' }]} />
        <span style={{ marginLeft: 'auto' }}>共 {p.rows.length * usable.length} 张 · 余额 {user?.credits ?? 0}</span>
      </div>
      {cost > (user?.credits ?? 0) && <p className="warn-p">积分不足</p>}
    </Modal>
  );
}
