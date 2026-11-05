import { useCallback, useEffect, useRef, useState } from 'react';
import { App, Spin } from 'antd';
import { BgColorsOutlined, ClockCircleOutlined, ExpandOutlined, HighlightOutlined, MessageOutlined, SkinOutlined, TranslationOutlined, UserSwitchOutlined, ZoomInOutlined, ScissorOutlined } from '@ant-design/icons';
import { api } from '../api/client';
import type { EditOp, Item, Job, JobPoll, Upload } from '../api/types';
import { useAuth } from '../lib/auth';
import { useErrorToast } from '../lib/notify';
import { EDIT_OP_LABELS } from '../lib/labels';
import UploadSlot from '../components/UploadSlot';
import EditModal, { type EditRequest } from '../components/EditModal';
import ItemCard from '../components/ItemCard';

const TOOLS: { op: EditOp; desc: string; icon: React.ReactNode }[] = [
  { op: 'cutout', desc: '原样抠出商品，白底或透明底', icon: <ScissorOutlined /> },
  { op: 'erase', desc: '涂抹去掉杂物、水印、多余的东西', icon: <HighlightOutlined /> },
  { op: 'expand', desc: '换比例，向外补全画面', icon: <ExpandOutlined /> },
  { op: 'upscale', desc: '按高清画质重绘，更清晰', icon: <ZoomInOutlined /> },
  { op: 'recolor', desc: '商品换个颜色出新色款', icon: <BgColorsOutlined /> },
  { op: 'free', desc: '说一句话改图', icon: <MessageOutlined /> },
  { op: 'translate', desc: '图上的文字翻译成别的语言', icon: <TranslationOutlined /> },
  { op: 'swap_model', desc: '真人图换成模特库里的模特', icon: <UserSwitchOutlined /> },
  { op: 'pose', desc: '同一个人同一身衣服换姿势', icon: <SkinOutlined /> },
];
const RATIOS: [string, number][] = [['1:1', 1], ['3:4', 0.75], ['4:3', 4 / 3], ['9:16', 9 / 16], ['16:9', 16 / 9]];
const nearest = (w: number, h: number) => RATIOS.reduce((b, r) => (Math.abs(Math.log(w / h / r[1])) < Math.abs(Math.log(w / h / b[1])) ? r : b))[0];

/** 工具箱: the edit tools on any photo the user uploads (not just generated ones). */
export default function Tools() {
  const { setCredits, user } = useAuth();
  const { message } = App.useApp();
  const toast = useErrorToast();
  const [pid, setPid] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [photo, setPhoto] = useState<Upload | null>(null);
  const [op, setOp] = useState<EditOp | null>(null);
  const [target, setTarget] = useState<Item | null>(null);
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs ?? [];

  const load = useCallback(async (p: string) => {
    try { setJobs(await api.get<Job[]>(`/api/projects/${p}/jobs`)); } catch (e) { toast(e); setJobs([]); }
  }, [toast]);
  useEffect(() => { api.get<{ projectId: string }>('/api/tools').then((r) => { setPid(r.projectId); void load(r.projectId); }).catch((e) => { toast(e); setJobs([]); }); }, [load, toast]);
  const active = (jobs ?? []).some((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!active || !pid) return;
    const t = window.setInterval(async () => {
      for (const j of jobsRef.current.filter((x) => x.status === 'queued' || x.status === 'running')) {
        try {
          const r = await api.get<JobPoll>(`/api/jobs/${j.id}`);
          setCredits(r.credits);
          setJobs((js) => (js ?? []).map((x) => (x.id === r.id ? { ...x, status: r.status, items: r.items } : x)));
        } catch { /* next tick */ }
      }
    }, 3000);
    return () => window.clearInterval(t);
  }, [active, pid, setCredits]);

  const photoItem: Item | null = photo ? {
    id: photo.id, jobId: '', ratio: nearest(photo.width || 1, photo.height || 1), status: 'succeeded', favorite: false, quality: 'standard',
    error: null, width: photo.width, height: photo.height, url: photo.url ?? photo.thumb, thumb: photo.thumb,
  } : null;
  const editing = target ?? photoItem;

  const pick = (o: EditOp) => {
    if (!photo) { message.info('先在左边上传一张要处理的图片'); return; }
    setTarget(null); setOp(o);
  };
  const submit = async (req: EditRequest) => {
    try {
      const r = target
        ? await api.post<{ id: string; reserved: number }>(`/api/items/${target.id}/edit`, req)
        : await api.post<{ id: string; reserved: number }>('/api/tools/edit', { ...req, assetId: photo!.id });
      if (user) setCredits(Math.max(0, user.credits - r.reserved));
      message.success('已开始处理，结果会出现在下面');
      if (pid) void load(pid);
      return true;
    } catch (e) { toast(e); return false; }
  };
  const items = (jobs ?? []).flatMap((j) => j.items.map((it) => ({ it, j })));

  return (
    <div className="page tools-page">
      <div className="page-hd">
        <h2>工具箱</h2>
        <span>上传任意一张图，直接修图，不用先生成</span>
      </div>
      <div className="tools-top">
        <UploadSlot value={photo} onChange={setPhoto} badge="原图" emptyTitle="上传要处理的图片" emptyHint="拖拽或点击 · ≤15MB" style={{ height: 220 }} />
        <div className="tool-grid">
          {TOOLS.map((t) => (
            <button key={t.op} type="button" className="tool" onClick={() => pick(t.op)} data-idle={!photo || undefined}>
              <i>{t.icon}</i><b>{t.op === 'cutout' ? '抠图' : EDIT_OP_LABELS[t.op]}</b><small>{t.desc}</small>
            </button>
          ))}
        </div>
      </div>
      <div className="page-sub"><h3>处理记录</h3><small><ClockCircleOutlined /> 结果保留 30 天，请及时下载</small></div>
      {!jobs ? <div className="empty-state" style={{ height: 200 }}><Spin /></div> : !items.length ? (
        <p className="muted-p">还没有处理过的图片。</p>
      ) : (
        <div className="grid tools-res">
          {items.map(({ it, j }) => (
            <ItemCard key={it.id} item={it} label={EDIT_OP_LABELS[j.editOp ?? 'free'] ?? '修改'}
              onChange={(p) => setJobs((js) => (js ?? []).map((x) => (x.id === j.id ? { ...x, items: x.items.map((i) => (i.id === it.id ? { ...i, ...p } : i)) } : x)))}
              onDeleted={() => setJobs((js) => (js ?? []).map((x) => (x.id === j.id ? { ...x, items: x.items.filter((i) => i.id !== it.id) } : x)))}
              onEdit={it.status === 'succeeded' ? () => { setTarget(it); setOp('free'); } : undefined} />
          ))}
        </div>
      )}
      <EditModal open={!!op && !!editing} item={editing} quality="standard" initialOp={op ?? 'free'} title={target ? '继续修改' : '处理这张图'}
        onClose={() => { setOp(null); setTarget(null); }} onSubmit={submit} />
    </div>
  );
}
