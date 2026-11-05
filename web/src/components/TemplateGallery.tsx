import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Modal, Radio, Spin } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import { TEMPLATE_CATEGORIES, type Template, type TemplateUse } from '../api/types';
import { useProjects } from '../lib/projects';
import { useErrorToast } from '../lib/notify';
import { MODE_LABELS, TAG_LABELS } from '../lib/labels';
import { newUuid } from '../lib/id';
import { useIsMobile } from '../lib/useMobile';
import type { TemplateSeed } from '../pages/Workbench';

type Target = 'new' | 'current';

function lastProjectId(): string | null {
  try { return sessionStorage.getItem('lumi.lastProject'); } catch { return null; }
}

/** Masonry 做同款 gallery with category chips + search, and the "use this template" dialog. */
export default function TemplateGallery({ limit, compactHeader }: { limit?: number; compactHeader?: boolean }) {
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');
  const [qLive, setQLive] = useState('');
  const [list, setList] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Template | null>(null);
  const [target, setTarget] = useState<Target>('new');
  const [busy, setBusy] = useState(false);
  const { projects, create, patchLocal } = useProjects();
  const nav = useNavigate();
  const toast = useErrorToast();
  const mobile = useIsMobile();
  const deb = useRef<number | undefined>(undefined);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get<Template[]>('/api/templates', { category: cat || undefined, q: q || undefined });
      setList(Array.isArray(r) ? r : []);
    } catch (e) { toast(e); } finally { setLoading(false); }
  }, [cat, q, toast]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => { void load(); }, 10 * 60 * 1000); // signed cover URLs expire
    return () => window.clearInterval(t);
  }, [load]);

  const onSearch = (v: string) => {
    setQLive(v);
    window.clearTimeout(deb.current);
    deb.current = window.setTimeout(() => setQ(v.trim().slice(0, 20)), 300);
  };

  const current = projects.find((p) => p.id === lastProjectId()) ?? null;
  const shown = limit ? list.slice(0, limit) : list;

  // Balanced masonry: place each card in the currently shortest column (keeps reading order roughly left→right).
  const cols = mobile ? 2 : 4;
  const columns = useMemo(() => {
    const out: Template[][] = Array.from({ length: cols }, () => []);
    const h = new Array(cols).fill(0);
    for (const t of shown) {
      const ar = t.width && t.height ? t.height / t.width : 4 / 3;
      const k = h.indexOf(Math.min(...h));
      out[k].push(t);
      h[k] += ar + 0.18; // + caption
    }
    return out;
  }, [shown, cols]);

  const use = async () => {
    if (!open) return;
    setBusy(true);
    try {
      const r = await api.post<TemplateUse>(`/api/templates/${open.id}/use`);
      const t = r.template ?? open;
      let pid: string;
      if (target === 'current' && current) {
        pid = current.id;
        if (current.mode !== t.mode) {
          await api.patch(`/api/projects/${pid}`, { mode: t.mode });
          patchLocal(pid, { mode: t.mode });
        }
      } else {
        pid = await create(t.mode, t.title.slice(0, 60));
      }
      const scene = !r.style; // scene templates come back without a style reference
      const seed: TemplateSeed = {
        nonce: newUuid(), title: t.title, prompt: scene ? '' : t.prompt ?? '', tags: t.tags ?? [], ratios: t.ratios?.length ? t.ratios : ['1:1'],
        quality: t.quality ?? 'standard', style: r.style,
        template: scene ? { id: t.id, title: t.title, fields: t.fields ?? [], values: {} } : null,
      };
      setOpen(null);
      nav(`/p/${pid}`, { state: { template: seed } });
    } catch (e) {
      toast(e);
    } finally {
      setBusy(false);
    }
  };

  const cover = open ? safeUrl(open.cover) ?? safeUrl(open.thumb) : undefined;

  return (
    <div className="tg">
      <div className={`tg-bar${compactHeader ? ' compact' : ''}`}>
        <div className="chips cat-chips">
          {['', ...TEMPLATE_CATEGORIES].map((c) => (
            <button key={c || 'all'} type="button" className={`chip${cat === c ? ' on' : ''}`} aria-pressed={cat === c} onClick={() => setCat(c)}>
              {c || '全部'}
            </button>
          ))}
        </div>
        <Input className="tg-search" allowClear value={qLive} onChange={(e) => onSearch(e.target.value)} maxLength={20}
          prefix={<SearchOutlined />} placeholder="搜模板，比如 拆解、礼盒、街拍" />
      </div>

      {loading && !list.length ? (
        <div className="empty-state" style={{ height: 300 }}><Spin /></div>
      ) : !shown.length ? (
        <div className="empty-state" style={{ height: 300 }}>
          <h3>{q ? `没有找到「${q}」` : cat ? `「${cat}」还没有模板` : '模板正在准备中'}</h3>
          <p>{q || cat ? '换个词或分类看看。' : '很快就会上线一批精选风格。'}</p>
        </div>
      ) : (
        <div className="masonry" style={{ ['--cols' as any]: cols }}>
          {columns.map((col, i) => (
            <div className="mcol" key={i}>
              {col.map((t) => {
                const img = safeUrl(t.thumb) ?? safeUrl(t.cover);
                const ar = t.width && t.height ? `${t.width} / ${t.height}` : '3 / 4';
                return (
                  <button type="button" className="mcard" key={t.id} onClick={() => { setOpen(t); setTarget('new'); }} aria-label={`做同款：${t.title}`}>
                    <span className="mimg" style={{ aspectRatio: ar }}>
                      {img ? <img src={img} alt="" loading="lazy" /> : null}
                      <span className="mgo">做同款</span>
                    </span>
                    <span className="mcap">
                      <b>{t.title}</b>
                      <small>{t.descr || t.category}</small>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}

      <Modal open={!!open} onCancel={() => !busy && setOpen(null)} footer={null} width={720} centered destroyOnHidden>
        {open && (
          <div className="tpl-dlg">
            <div className="tpl-dlg-img">{cover ? <img src={cover} alt={open.title} /> : <div className="tpl-ph" />}</div>
            <div className="tpl-dlg-tx">
              <div className="tpl-dlg-hd">
                <h3>{open.title}</h3>
                <span className="mode-badge static">{MODE_LABELS[open.mode]}模式</span>
              </div>
              <div className="muted">{[open.category, open.purpose].filter(Boolean).join(' · ')}</div>
              {open.descr && <p className="tpl-dlg-desc">{open.descr}</p>}
              <dl className="tpl-meta">
                {!open.fields?.length && open.tags?.length > 0 && (<><dt>场景</dt><dd>{open.tags.map((x) => TAG_LABELS[x] ?? x).join(' · ')}</dd></>)}
                {open.fields?.length > 0 && (<><dt>可填</dt><dd>{open.fields.map((f) => f.label).join(' · ')}</dd></>)}
                <dt>尺寸</dt><dd>{open.ratios?.join(' / ') || '1:1'}</dd>
              </dl>
              <p className="tpl-dlg-hint">
                {open.fields?.length || open.allowText
                  ? '上传你的商品，按这个版式出图。图上的文字可以自己填，留空就不写。'
                  : '上传你的商品，按这个场景和光线出图。示例里的商品只是演示。'}
              </p>
              <div className="tpl-dlg-target">
                <div className="lbl"><span>用在</span></div>
                <Radio.Group value={target} onChange={(e) => setTarget(e.target.value)} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <Radio value="new">新建项目「{open.title}」</Radio>
                  <Radio value="current" disabled={!current}>
                    {current ? <>当前项目「<span className="ell">{current.name}</span>」{current.mode !== open.mode && <span className="muted">（将切换到{MODE_LABELS[open.mode]}模式）</span>}</> : '当前项目（暂无）'}
                  </Radio>
                </Radio.Group>
              </div>
              <Button className="btn-ink" block onClick={use} loading={busy} style={{ marginTop: 'auto' }}>做同款</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
