import { useIsMobile } from '../lib/useMobile';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { App, Button, Dropdown, Spin, Tooltip, Typography } from 'antd';
import { ClockCircleOutlined, LockOutlined, RedoOutlined, SwapOutlined } from '@ant-design/icons';
import EditModal, { type EditRequest } from '../components/EditModal';
import dayjs from 'dayjs';
import { api, ApiError, safeUrl } from '../api/client';
import type { Brand, Item, Job, JobPoll, JobTemplate, Mode, Quality, Upload } from '../api/types';
import { useProjects } from '../lib/projects';
import { useAuth } from '../lib/auth';
import { useErrorToast } from '../lib/notify';
import { EDIT_OP_LABELS, MODE_LABELS, ROLE_LABELS } from '../lib/labels';
import ExportMenu from '../components/ExportMenu';
import ItemCard, { downloadItem } from '../components/ItemCard';
import Composer, { rowsFromJob, type JobBody } from '../components/Composer';
import Viewer, { cardType, shownIndex, type Card, type Version } from '../components/Viewer';
const DesignEditor = lazy(() => import('../components/DesignEditor'));
import BatchEdit, { type BatchEditRequest } from '../components/BatchEdit';
import { newUuid } from '../lib/id';

/** Router state passed by the 灵感模板 page when a template is applied. */
export interface TemplateSeed {
  nonce: string;
  title: string;
  prompt: string;
  tags: string[];
  ratios: string[];
  quality: Quality;
  style: Upload | null;
  template?: JobTemplate | null;
}

/** Router state passed by the home page (hero box or a feature card). */
export interface StartSeed { product?: Upload | null; prompt?: string; tags?: string[] }

function seedFromStart(st: StartSeed, nonce: string): Job {
  return {
    id: `start-${nonce}`, status: 'done', quality: 'standard', prompt: st.prompt ?? '', tags: st.tags ?? [], ratios: ['1:1'], perRatio: 2,
    credits: 0, createdAt: new Date().toISOString(), items: [],
    inputs: st.product ? [{ assetId: st.product.id, role: 'product', thumb: st.product.thumb }] : [],
  };
}

function seedFromTemplate(t: TemplateSeed): Job {
  return {
    id: `tpl-${t.nonce}`, status: 'done', quality: t.quality, prompt: t.prompt, tags: t.tags, ratios: t.ratios, perRatio: 2,
    credits: 0, createdAt: new Date().toISOString(), items: [],
    inputs: t.style ? [{ assetId: t.style.id, role: 'style', thumb: t.style.thumb }] : [],
    template: t.template ?? null,
  };
}

const ACTIVE = new Set(['queued', 'running']);
const isActive = (j: { status: string }) => ACTIVE.has(j.status);

/* ------------------------------------------------------------------ */

function statusText(j: Job, cards: Card[]) {
  const total = cards.length;
  const shown = cards.map((c) => c.versions[shownIndex(c)].item);
  const ok = shown.filter((i) => i.status === 'succeeded').length;
  const failed = shown.filter((i) => i.status === 'failed').length;
  if (j.status === 'queued') return '排队中';
  if (j.status === 'running') return `生成中 ${ok}/${total}`;
  if (failed && ok) return `${ok} 张完成 · ${failed} 张失败`;
  if (failed && !ok) return '生成失败，积分已退回';
  return `${ok} 张`;
}

/** Group retries / edits under the image they came from. Returns the batches to show, each with its cards. */
function buildBoard(jobs: Job[]): { job: Job; cards: Card[] }[] {
  const itemJob = new Map<string, Job>();
  for (const j of jobs) for (const it of j.items) itemJob.set(it.id, j);
  const children = new Map<string, Job[]>();
  const roots: Job[] = [];
  for (const j of jobs) {
    if (j.parentItemId && itemJob.has(j.parentItemId)) {
      const arr = children.get(j.parentItemId) ?? [];
      arr.push(j); children.set(j.parentItemId, arr);
    } else roots.push(j);
  }
  const chain = (it: Item, j: Job, out: Version[], depth = 0) => {
    out.push({ item: it, job: j });
    if (depth > 30) return;
    const kids = (children.get(it.id) ?? []).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const k of kids) for (const ki of k.items) chain(ki, k, out, depth + 1);
  };
  const board = roots.map((j) => ({
    job: j,
    cards: j.items.map((it) => { const vs: Version[] = []; chain(it, j, vs); return { key: it.id, job: j, versions: vs }; }),
  }));
  // newest activity first: a batch moves up when one of its images was just edited
  const last = (b: { job: Job; cards: Card[] }) => b.cards.reduce((m, c) => c.versions.reduce((mm, v) => (v.job.createdAt > mm ? v.job.createdAt : mm), m), b.job.createdAt);
  return board.sort((x, y) => last(y).localeCompare(last(x)));
}

function Batch({ job, cards, onRerun, rerunBusy, onOpen, onRetry, onEdit, onText, onItem, onRemoveItem, lockedJobId, onLock, onBatchEdit }: {
  job: Job; cards: Card[]; onRerun: (j: Job) => void; rerunBusy: boolean; onOpen: (key: string) => void;
  onRetry: (it: Item) => void; onEdit: (it: Item, j: Job) => void; onText: (it: Item, j: Job) => void;
  onItem: (jobId: string, itemId: string, patch: Partial<Item>) => void; onRemoveItem: (jobId: string, itemId: string) => void;
  lockedJobId: string | null; onLock: (j: Job) => void; onBatchEdit: (j: Job, itemIds: string[], r: BatchEditRequest) => Promise<boolean>;
}) {
  const kindLabel = job.kind === 'edit' ? `${EDIT_OP_LABELS[job.editOp ?? 'free'] ?? '修改'}${job.editText ? `：${job.editText}` : ''}`
    : job.kind === 'retry' ? '重试一张' : '';
  const types = cards.map(cardType).filter(Boolean);
  const typeSum = [...new Set(types)].map((t) => { const n = types.filter((x) => x === t).length; return `${t}${n > 1 ? ` ×${n}` : ''}`; }).join(' · ');
  const name = job.facts?.name?.trim();
  const summary = kindLabel || [name, job.prompt?.trim()].filter(Boolean).join(' · ') || (job.template ? `做同款 · ${job.template.title}` : '') || typeSum;
  const shownOk = cards.map((c) => c.versions[shownIndex(c)].item).filter((i) => i.status === 'succeeded' && !i.expired);
  const isLocked = lockedJobId === job.id;
  const anyActive = cards.some((c) => c.versions.some((v) => ACTIVE.has(v.item.status)));
  return (
    <section className="batch">
      <div className="batch-hd">
        {!!job.inputs?.length && (
          <div className="batch-ins">
            {job.inputs.map((x) => {
              const u = safeUrl(x.thumb);
              const role = ROLE_LABELS[x.role] ?? x.role;
              if (x.expired || !u) return <Tooltip key={x.assetId} title={`${role} · 已过期`}><span className="in-exp" aria-label={`${role}已过期`}><ClockCircleOutlined /></span></Tooltip>;
              return <Tooltip key={x.assetId} title={role}><img src={u} alt={role} /></Tooltip>;
            })}
          </div>
        )}
        <div className="batch-tx">
          <div className={`p${summary ? '' : ' muted'}`} title={summary}>{summary || '未填写描述'}</div>
          <div className="m">
            <span className={anyActive ? 'status-run' : ''}>{statusText(job, cards)}</span>
            <i className="dot" /><span>{job.quality === 'hd' ? '高清' : '标准'}</span>
            <i className="dot" /><span>{dayjs(job.createdAt).fromNow()}</span>
          </div>
        </div>
        <div className="batch-act">
          {shownOk.length > 0 && !isActive(job) && (
            <Tooltip title={isLocked ? '这一批的风格已锁定，新生成的图会沿用' : '之后生成的图都沿用这一批的光线和色调'}>
              <Button size="small" icon={<LockOutlined />} className={isLocked ? 'locked' : ''} onClick={() => !isLocked && onLock(job)}>{isLocked ? '已锁定' : '锁定风格'}</Button>
            </Tooltip>
          )}
          {shownOk.length > 1 && <BatchEdit count={shownOk.length} quality={job.quality} onSubmit={(r) => onBatchEdit(job, shownOk.map((i) => i.id), r)} />}
          <ExportMenu jobId={job.id} count={shownOk.length} />
          {job.kind && job.kind !== 'generate' ? null : job.inputs?.some((x) => x.expired) ? (
            <Tooltip title="这一批用到的图片已超过保存期限，请在左侧重新上传后生成">
              <Button size="small" icon={<RedoOutlined />} disabled>再来一批</Button>
            </Tooltip>
          ) : (
            <Button size="small" icon={<RedoOutlined />} onClick={() => onRerun(job)} disabled={rerunBusy}>再来一批</Button>
          )}
        </div>
      </div>
      <div className="grid jrow">
        {cards.map((c) => {
          const v = c.versions[shownIndex(c)];
          const pending = c.versions.slice(1).some((x) => ACTIVE.has(x.item.status));
          const canRetry = !(v.job.inputs?.some((x) => x.expired)) && v.job.kind !== 'edit';
          return (
            <ItemCard key={c.key} item={v.item} label={[cardType(c), v.item.ratio].filter(Boolean).join(' · ')}
              versions={c.versions.length} pending={pending}
              onChange={(p) => onItem(v.job.id, v.item.id, p)} onDeleted={() => onRemoveItem(v.job.id, v.item.id)}
              onOpen={() => onOpen(c.key)}
              onRetry={canRetry ? () => onRetry(v.item) : undefined}
              onEdit={v.item.status === 'succeeded' ? () => onEdit(v.item, v.job) : undefined}
              onText={v.item.status === 'succeeded' ? () => onText(v.item, v.job) : undefined} />
          );
        })}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

export default function Workbench() {
  const { id = '' } = useParams();
  const { projects, loaded, patchLocal, reload } = useProjects();
  const { setCredits, user } = useAuth();
  const { message, modal } = App.useApp();
  const toast = useErrorToast();
  const nav = useNavigate();
  const loc = useLocation();
  const tplSeed = (loc.state as { template?: TemplateSeed } | null)?.template;
  const startSeed = (loc.state as { start?: StartSeed } | null)?.start;
  const startKey = (loc as { key?: string }).key ?? '';
  const project = projects.find((p) => p.id === id);

  const [jobs, setJobs] = useState<Job[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const [mTab, setMTab] = useState<'make' | 'results'>('make');
  const mobile = useIsMobile();
  const [seed, setSeed] = useState<Job | null | undefined>(undefined);
  const jobsRef = useRef<Job[]>([]);
  jobsRef.current = jobs;
  const seededFor = useRef<string | null>(null);

  const loadJobs = useCallback(async () => {
    try {
      const list = await api.get<Job[]>(`/api/projects/${id}/jobs`);
      const arr = Array.isArray(list) ? list : [];
      setJobs(arr);
      if (seededFor.current !== id) { seededFor.current = id; setSeed(arr.find((j) => !j.kind || j.kind === 'generate') ?? null); }
    } catch (e) {
      toast(e);
      if (seededFor.current !== id) { seededFor.current = id; setSeed(null); }
    } finally {
      setLoadingJobs(false);
    }
  }, [id, toast]);

  useEffect(() => { try { sessionStorage.setItem('lumi.lastProject', id); } catch { /* ignore */ } }, [id]);

  useEffect(() => {
    setJobs([]);
    setSeed(undefined);
    setLoadingJobs(true);
    void loadJobs();
    const t = window.setInterval(() => { void loadJobs(); }, 10 * 60 * 1000); // signed URLs expire (~15 min)
    return () => window.clearInterval(t);
  }, [loadJobs]);

  // poll every 3s while any batch is queued/running
  const hasActive = jobs.some(isActive);
  useEffect(() => {
    if (!hasActive) return;
    let stopped = false;
    const tick = async () => {
      const active = jobsRef.current.filter(isActive);
      let finished = false;
      for (const j of active) {
        try {
          const r = await api.get<JobPoll>(`/api/jobs/${j.id}`);
          if (stopped) return;
          if (typeof r.credits === 'number') setCredits(r.credits);
          if (!ACTIVE.has(r.status)) finished = true;
          setJobs((js) => js.map((x) => (x.id === r.id ? { ...x, status: r.status, items: r.items } : x)));
        } catch { /* transient; next tick retries */ }
      }
      if (finished && !stopped) { void reload(); void loadJobs(); }
    };
    const t = window.setInterval(() => { void tick(); }, 3000);
    return () => { stopped = true; window.clearInterval(t); };
  }, [hasActive, setCredits, reload, loadJobs]);

  const submit = useCallback(async (b: Omit<JobBody, 'projectId'>) => {
    if (submittingRef.current) return false;
    submittingRef.current = true;
    setSubmitting(true);
    // one key per click: a retried / double-sent request is replayed by the server instead of charging twice
    const idemKey = newUuid();
    try {
      const r = await api.post<{ id: string; items: string[]; reserved: number }>('/api/jobs', { projectId: id, ...b },
        { headers: { 'Idempotency-Key': idemKey } });
      if (jobsRef.current.some((j) => j.id === r.id)) { void loadJobs(); return true; } // replayed
      const optimistic: Job = {
        id: r.id, status: 'queued', quality: b.quality, prompt: b.prompt, tags: [...new Set(b.rows.map((x) => x.tag).filter((t): t is string => !!t))],
        ratios: [...new Set(b.rows.map((x) => x.ratio))], perRatio: 1, kind: 'generate', facts: b.facts ?? null,
        shots: b.templateId ? null : b.rows.map((x) => ({ tag: x.tag, text: x.text })),
        credits: r.reserved, createdAt: new Date().toISOString(), inputs: [],
        items: r.items.map((itemId, i) => ({
          id: itemId, jobId: r.id, idx: i, ratio: b.rows[i]?.ratio ?? '1:1', status: 'queued', favorite: false, quality: b.quality,
          error: null, width: null, height: null, url: null, thumb: null,
        })),
      };
      setJobs((js) => [optimistic, ...js]);
      if (user) setCredits(Math.max(0, user.credits - (r.reserved ?? 0)));
      message.success('已开始生成');
      setMTab('results');
      void loadJobs();
      void reload();
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'idempotency_in_progress') {
        message.info('上一次提交还在处理中，稍后会出现在结果里');
        window.setTimeout(() => { void loadJobs(); }, 2000);
      } else if (e instanceof ApiError && e.code === 'idempotency_conflict') {
        message.warning('提交冲突了，已刷新列表，请确认后再点一次生成');
        void loadJobs();
      } else if (e instanceof ApiError && (e.code === 'asset_expired' || e.status === 410)) {
        message.warning(e.message || '有图片已超过保存期限被删除，请重新上传');
      } else {
        toast(e);
      }
      return false;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [id, user, setCredits, message, toast, loadJobs, reload]);

  const rerun = (j: Job) => {
    if (j.inputs?.some((x) => x.expired)) { message.warning('这一批用到的图片已超过保存期限，请重新上传后生成'); return; }
    void submit({
      prompt: j.prompt ?? '', tags: [], quality: j.quality,
      rows: rowsFromJob(j).map((r) => ({ ratio: r.ratio, tag: j.template ? null : r.tag, text: r.text })),
      inputs: (j.inputs ?? []).map((x) => ({ assetId: x.assetId, role: x.role })),
      ...(j.facts && (j.facts.name || j.facts.points?.length) ? { facts: { name: j.facts.name, points: j.facts.points } } : {}),
      ...(j.template ? { templateId: j.template.id, templateFields: j.template.values ?? {} } : {}),
    });
  };

  const afterSpawn = (r: { reserved: number }, msg: string) => {
    if (user) setCredits(Math.max(0, user.credits - (r.reserved ?? 0)));
    message.success(msg);
    setMTab('results');
    void loadJobs();
    void reload();
  };
  const retryItem = async (it: Item) => {
    try { afterSpawn(await api.post<{ id: string; reserved: number }>(`/api/items/${it.id}/retry`, {}), '已开始重试，新图会作为这张的新版本'); }
    catch (e) { toast(e); }
  };
  const [editing, setEditing] = useState<{ item: Item; job: Job } | null>(null);
  const [texting, setTexting] = useState<Item | null>(null);
  const submitEdit = async (req: EditRequest) => {
    if (!editing) return false;
    try { afterSpawn(await api.post<{ id: string; reserved: number }>(`/api/items/${editing.item.id}/edit`, req), '已开始修改，完成后是这张图的新版本'); return true; }
    catch (e) { toast(e); return false; }
  };
  const batchEdit = async (j: Job, itemIds: string[], r: BatchEditRequest) => {
    try {
      const res = await api.post<{ jobs: string[]; reserved: number }>(`/api/jobs/${j.id}/edit-all`, { ...r, itemIds });
      afterSpawn(res, `已开始修改 ${res.jobs.length} 张`);
      return true;
    } catch (e) { toast(e); return false; }
  };
  const lockStyle = async (j: Job) => {
    try {
      await api.post(`/api/projects/${id}/style-lock`, { jobId: j.id });
      await reload();
      message.success('已锁定这一批的风格，之后生成的图会沿用');
    } catch (e) { toast(e); }
  };
  const unlockStyle = async () => {
    try { await api.del(`/api/projects/${id}/style-lock`); await reload(); message.success('已解锁风格'); } catch (e) { toast(e); }
  };
  const saveBrand = async (b: Brand | null) => {
    try {
      const r = await api.patch<{ brand: Brand | null }>(`/api/projects/${id}`, { brand: b });
      patchLocal(id, { brand: r.brand ?? null });
      message.success(r.brand ? '品牌设置已保存，之后每批都会沿用' : '已清空品牌设置');
    } catch (e) { toast(e); throw e; }
  };

  const onItem = (jobId: string, itemId: string, patch: Partial<Item>) =>
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, items: j.items.map((i) => (i.id === itemId ? { ...i, ...patch } : i)) } : j)));
  const onRemoveItem = (jobId: string, itemId: string) =>
    setJobs((js) => js.map((j) => (j.id === jobId ? { ...j, items: j.items.filter((i) => i.id !== itemId) } : j)).filter((j) => j.items.length));

  const board = useMemo(() => buildBoard(jobs), [jobs]);
  const allCards = useMemo(() => board.flatMap((b) => b.cards), [board]);
  const [viewKey, setViewKey] = useState<string | null>(null);
  const viewIndex = viewKey ? allCards.findIndex((c) => c.key === viewKey) : -1;

  const favorite = async (it: Item, j: Job) => {
    const next = !it.favorite;
    onItem(j.id, it.id, { favorite: next });
    try { await api.post(`/api/items/${it.id}/favorite`, { favorite: next }); } catch (e) { onItem(j.id, it.id, { favorite: !next }); toast(e); }
  };
  const removeVersion = (it: Item, j: Job) => modal.confirm({
    title: '删除这一版？', content: '删除后无法恢复，其它版本保留。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
    onOk: async () => { try { await api.del(`/api/items/${it.id}`); onRemoveItem(j.id, it.id); } catch (e) { toast(e); } },
  });

  const rename = async (name: string) => {
    const n = name.trim().slice(0, 60);
    if (!project || !n || n === project.name) return;
    const old = project.name;
    patchLocal(id, { name: n });
    try { await api.patch(`/api/projects/${id}`, { name: n }); } catch (e) { patchLocal(id, { name: old }); toast(e); }
  };
  const switchMode = async (m: Mode) => {
    if (!project || m === project.mode) return;
    patchLocal(id, { mode: m });
    try {
      await api.patch(`/api/projects/${id}`, { mode: m });
      message.success(`已切换到${MODE_LABELS[m]}模式`);
    } catch (e) { patchLocal(id, { mode: project.mode }); toast(e); }
  };

  const stats = useMemo(() => {
    const shown = allCards.map((c) => c.versions[shownIndex(c)].item);
    const ok = shown.filter((i) => i.status === 'succeeded').length;
    const activeItems = jobs.filter(isActive).flatMap((j) => j.items);
    const activeDone = activeItems.filter((i) => !ACTIVE.has(i.status)).length;
    return { ok, activeTotal: activeItems.length, activeDone };
  }, [jobs, allCards]);

  if (!loaded) return <div className="empty-state"><Spin /></div>;
  if (!project) {
    return (
      <div className="empty-state">
        <h3>项目不存在</h3>
        <p>它可能已被删除。</p>
        <Button onClick={() => nav('/')}>返回</Button>
      </div>
    );
  }

  const mode = project.mode;
  const other: Mode = mode === 'simple' ? 'detailed' : 'simple';

  return (
    <div className={`wb${mobile ? ` m-${mTab}` : ''}`}>
      {mobile && (
        <div className="m-tabs" role="tablist">
          <button role="tab" aria-selected={mTab === 'make'} className={mTab === 'make' ? 'on' : ''} onClick={() => setMTab('make')}>创作</button>
          <button role="tab" aria-selected={mTab === 'results'} className={mTab === 'results' ? 'on' : ''} onClick={() => setMTab('results')}>
            结果{stats.activeTotal ? <em>{stats.activeDone}/{stats.activeTotal}</em> : stats.ok ? <em>{stats.ok}</em> : null}
          </button>
        </div>
      )}
      {seed === undefined || seededFor.current !== id
        ? <div className="side" />
        : <Composer key={`${id}:${tplSeed?.nonce ?? ''}:${startSeed ? startKey : ''}`} mode={mode} busy={submitting}
          seed={tplSeed ? seedFromTemplate(tplSeed) : startSeed ? seedFromStart(startSeed, startKey) : seed} fromTemplate={tplSeed?.title} onSubmit={submit}
          project={project} onUnlock={() => void unlockStyle()} onBrand={saveBrand} />}
      <div className="work">
        <div className="hd">
          <Typography.Title level={2} className="name" title={project.name}
            editable={{ onChange: rename, maxLength: 60, tooltip: '重命名', triggerType: ['icon', 'text'] }}>
            {project.name}
          </Typography.Title>
          <Dropdown trigger={['click']} menu={{
            items: [{ key: other, icon: <SwapOutlined />, label: `切换到${MODE_LABELS[other]}模式` }],
            onClick: ({ key }) => void switchMode(key as Mode),
          }}>
            <button className="mode-badge" type="button">{MODE_LABELS[mode]}模式 <SwapOutlined style={{ fontSize: 10 }} /></button>
          </Dropdown>
          <span className="meta">{stats.activeTotal ? `生成中 ${stats.activeDone} / ${stats.activeTotal}` : stats.ok ? `共 ${stats.ok} 张` : ''}</span>
        </div>
        <div className="prog">
          <div style={{ width: stats.activeTotal ? `${Math.max(4, (stats.activeDone / stats.activeTotal) * 100)}%` : '0%' }} />
        </div>
        <div className="results">
          {loadingJobs && !jobs.length ? (
            <div className="empty-state"><Spin /></div>
          ) : !jobs.length ? (
            <div className="empty-state">
              <div className="art" aria-hidden>
                {mode === 'simple'
                  ? (<><img src="/img/r1.jpg" alt="" /><img src="/img/r3.jpg" alt="" /><img src="/img/r5.jpg" alt="" /></>)
                  : (<><img src="/img/c-r3.jpg" alt="" /><img src="/img/c-r1.jpg" alt="" /><img src="/img/c-r4.jpg" alt="" /></>)}
              </div>
              <h3>{mode === 'simple' ? '三步出一整套商品图' : '放上要搭配的单品，一次出一整套'}</h3>
              <p>{mode === 'simple'
                ? `${mobile ? '在「创作」里' : '左侧'}上传商品图，AI 会先写好卖点和每张图怎么拍；选个平台套餐，点「生成」。`
                : '放上 1–3 件单品，衣服、鞋包、配饰都行，会自动识别。可以再选一位模特，选个套餐就能生成。'}</p>
            </div>
          ) : (
            board.map((b) => <Batch key={b.job.id} job={b.job} cards={b.cards} onRerun={rerun} rerunBusy={submitting}
              onOpen={setViewKey} onRetry={(it) => void retryItem(it)} onEdit={(it, jb) => setEditing({ item: it, job: jb })} onText={(it) => setTexting(it)}
              onItem={onItem} onRemoveItem={onRemoveItem} lockedJobId={project.styleLock?.jobId ?? null} onLock={(jb) => void lockStyle(jb)} onBatchEdit={batchEdit} />)
          )}
          <EditModal open={!!editing} item={editing?.item ?? null} quality={editing?.job.quality ?? 'standard'} onClose={() => setEditing(null)} onSubmit={submitEdit} />
          {texting && <Suspense fallback={null}><DesignEditor open={!!texting} item={texting} onClose={() => setTexting(null)} brandColor={project.brand?.color}
            onSaved={() => { void loadJobs(); }} /></Suspense>}
          {viewIndex >= 0 && (
            <Viewer cards={allCards} index={viewIndex} onIndex={(i) => setViewKey(allCards[i]?.key ?? null)} onClose={() => setViewKey(null)}
              actions={{
                download: (it) => { downloadItem(it.id).catch(toast); },
                edit: (it, j) => setEditing({ item: it, job: j }),
                text: (it) => setTexting(it),
                retry: (it) => void retryItem(it),
                favorite: (it, j) => void favorite(it, j),
                remove: removeVersion,
              }} />
          )}
        </div>
      </div>
    </div>
  );
}
