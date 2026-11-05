import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Input, Segmented, Spin, Tooltip } from 'antd';
import { CloseOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api, ApiError, safeUrl } from '../api/client';
import type { Brand, Facts, Job, JobInput, JobTemplate, Mode, Portrait, Project, Quality, Role, Row, Upload } from '../api/types';
import { useOptions } from '../lib/projects';
import { useAuth } from '../lib/auth';
import { DETAILED_PACKS, DETAILED_TAGS, RATIO_OPTIONS, SIMPLE_PACKS, SIMPLE_TAGS, TAG_LABELS, TEXT_TAGS, shotText, type Pack } from '../lib/labels';
import { BrandPanel, FactsPanel, PackRow, RowsEditor, StepHead, StyleLockBar } from './ComposerExtras';
import UploadSlot from './UploadSlot';
import ModelSelect from './models/ModelSelect';
import AiModelCreate from './models/AiModelCreate';
import UploadModelModal from './models/UploadModelModal';
import { useModelLibrary } from '../lib/models';

export interface JobBody {
  projectId: string;
  prompt: string;
  tags: string[];
  quality: Quality;
  rows: { ratio: string; tag: string | null; text: string }[];
  inputs: { assetId: string; role: Role }[];
  templateId?: string;
  templateFields?: Record<string, string>;
  facts?: Facts;
  useStyleLock?: boolean;
}

type ModelMode = 'none' | 'ai' | 'mine';
interface PickedModel { assetId: string; thumb: string | null; name?: string; source?: Portrait['source'] }

const DETAIL_ROLES: Role[] = ['product', 'top', 'bottom', 'shoes', 'bag', 'accessory'];
let rowSeq = 0;
const rk = () => `r${++rowSeq}`;
function asUpload(x?: JobInput): Upload | null {
  return x && x.thumb && !x.expired ? { id: x.assetId, thumb: x.thumb, width: 0, height: 0 } : null;
}

/** Re-number default shot lines so repeated types step through different variants. Edited lines are kept. */
function refreshDefaults(rows: Row[]): Row[] {
  const seen: Record<string, number> = {};
  return rows.map((r) => {
    const n = r.tag ? (seen[r.tag] = (seen[r.tag] ?? -1) + 1) : 0;
    return r.edited ? r : { ...r, text: shotText(r.tag, n) };
  });
}
export function rowsFromPack(p: Pack): Row[] {
  return refreshDefaults(p.rows.map(([tag, ratio]) => ({ key: rk(), tag, ratio, text: '' })));
}

/** Rows a past batch was made with (items carry the ratio, shots carry type + line). */
export function rowsFromJob(j: Job): Row[] {
  const n = j.items.length || (j.ratios?.length ?? 1) * (j.perRatio || 1);
  const ratioSeq = j.items.length ? j.items.map((i) => i.ratio) : (j.ratios ?? ['1:1']).flatMap((r) => Array.from({ length: j.perRatio || 1 }, () => r));
  const tags = j.tags ?? [];
  return Array.from({ length: n }, (_, i) => {
    const s = j.shots?.[i];
    const tag = s?.tag ?? (tags.length ? tags[i % tags.length] : null);
    return { key: rk(), tag, ratio: ratioSeq[i] ?? '1:1', text: s?.text ?? '', edited: !!s?.text };
  });
}

/** `seed` = the project's latest batch; the form starts from it so re-entering a project feels continuous. */
export default function Composer({ mode, busy, seed, fromTemplate, onSubmit, project, onUnlock, onBrand }: {
  mode: Mode; busy: boolean; seed: Job | null; fromTemplate?: string; onSubmit: (b: Omit<JobBody, 'projectId'>) => Promise<boolean>;
  project: Project; onUnlock: () => void; onBrand: (b: Brand | null) => Promise<void>;
}) {
  const opts = useOptions();
  const { user } = useAuth();
  const { message } = App.useApp();
  const lockAsset = project.styleLock?.assetId ?? null;
  const ins = (seed?.inputs ?? []).filter((x) => !(x.role === 'style' && lockAsset && x.assetId === lockAsset));
  const [product, setProduct] = useState<Upload | null>(() => asUpload(ins.find((x) => x.role === 'product')));
  const [style, setStyle] = useState<Upload | null>(() => asUpload(ins.find((x) => x.role === 'style' || x.role === 'clone')));
  const [refUse, setRefUse] = useState<'style' | 'clone'>(() => (ins.some((x) => x.role === 'clone') ? 'clone' : 'style'));
  const [facts, setFacts] = useState<Facts>(() => ({ name: seed?.facts?.name ?? '', points: seed?.facts?.points?.length ? [...seed.facts.points] : [''] }));
  const [useLock, setUseLock] = useState(true);
  const [slots, setSlots] = useState<(Upload | null)[]>(() => {
    const s = ins.filter((x) => DETAIL_ROLES.includes(x.role)).slice(0, 3).map((x) => asUpload(x));
    return [0, 1, 2].map((i) => s[i] ?? null);
  });
  const seedModel = ins.find((x) => x.role === 'model' && !x.expired && x.thumb);
  const [model, setModel] = useState<PickedModel | null>(() => (seedModel ? { assetId: seedModel.assetId, thumb: seedModel.thumb } : null));
  const [modelMode, setModelMode] = useState<ModelMode>(() => (seedModel ? 'mine' : 'none'));
  const [newModal, setNewModal] = useState<'ai' | 'upload' | null>(null);
  const lib = useModelLibrary(mode === 'detailed');
  const [expiredHint, setExpiredHint] = useState(ins.some((x) => x.expired));
  const packs = mode === 'simple' ? SIMPLE_PACKS : DETAILED_PACKS;
  const tagList = mode === 'simple' ? SIMPLE_TAGS : DETAILED_TAGS;
  const ratioList = RATIO_OPTIONS.filter((r) => opts.ratios.includes(r.value)).map((r) => r.value);
  const [tpl, setTpl] = useState<JobTemplate | null>(seed?.template ?? null);
  const [tplValues, setTplValues] = useState<Record<string, string>>(() => ({ ...(seed?.template?.values ?? {}) }));
  const [tplRatio, setTplRatio] = useState<string>(() => seed?.ratios?.[0] ?? '1:1');
  const [tplCount, setTplCount] = useState<number>(() => Math.min(4, Math.max(1, seed?.items?.length || 2)));

  const [pack, setPack] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>(() => {
    if (seed && !seed.template && (seed.items.length || seed.tags?.length)) {
      if (seed.items.length) return refreshDefaults(rowsFromJob(seed).filter((r) => !r.tag || tagList.includes(r.tag)));
      return refreshDefaults(seed.tags.filter((t) => tagList.includes(t)).map((t) => ({ key: rk(), tag: t, ratio: seed.ratios?.[0] ?? '1:1', text: '' })));
    }
    return rowsFromPack(packs[0]);
  });
  useEffect(() => { if (!rows.length) setRows(rowsFromPack(packs[0])); }, [rows.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // switching mode swaps the vocabulary
  const firstMode = useRef(mode);
  useEffect(() => {
    if (firstMode.current === mode) return;
    firstMode.current = mode;
    setPack(null);
    setRows(rowsFromPack((mode === 'simple' ? SIMPLE_PACKS : DETAILED_PACKS)[0]));
  }, [mode]);

  const attributed = useRef(false);
  useEffect(() => {
    if (attributed.current || lib.loading || !model) return;
    attributed.current = true;
    const hit = lib.list.find((p) => p.portraitAssetId === model.assetId);
    if (hit) { setModel({ assetId: hit.portraitAssetId, thumb: hit.thumb, name: hit.name, source: hit.source }); setModelMode(hit.source === 'ai' ? 'ai' : 'mine'); }
  }, [lib.loading, lib.list, model]);
  const pickPortrait = (p: Portrait | null) => setModel(p ? { assetId: p.portraitAssetId, thumb: p.thumb, name: p.name, source: p.source } : null);
  const switchModelMode = (m: ModelMode) => {
    setModelMode(m);
    setModel((cur) => {
      if (!cur || m === 'none') return cur;
      if (m === 'ai') return cur.source === 'ai' ? cur : null;
      return cur.source === 'ai' ? null : cur;
    });
  };
  const [prompt, setPrompt] = useState(seed?.prompt ?? '');
  const [quality, setQuality] = useState<Quality>(seed?.quality ?? 'standard');

  const filledSlots = slots.filter((s): s is Upload => !!s);
  const productImages = mode === 'simple' ? (product ? [product] : []) : filledSlots;
  const planRows: Row[] = tpl ? Array.from({ length: tplCount }, (_, i) => ({ key: `t${i}`, tag: null, ratio: tplRatio, text: '' })) : rows;
  const total = planRows.length;
  const unit = opts.prices[quality] ?? 0;
  const cost = unit * total;
  const credits = user?.credits ?? 0;
  const max = opts.maxImagesPerJob;
  const needsPoints = !tpl && rows.some((r) => TEXT_TAGS.includes(r.tag ?? '')) && !facts.points.some((p) => p.trim());

  let blocker: string | null = null;
  if (mode === 'simple' && !product) blocker = '先上传一张商品图';
  if (mode === 'detailed' && !filledSlots.length) blocker = '至少上传一件商品';
  if (mode === 'detailed' && modelMode === 'ai' && !model) blocker = '请选择或新建一位 AI 模特';
  if (mode === 'detailed' && modelMode === 'mine' && !model) blocker = '请选择或上传模特，或选择「不用」';
  if (!total) blocker = '至少要一张图';
  if (total > max) blocker = `每次最多生成 ${max} 张`;
  if (!blocker && cost > credits) blocker = '积分不足';

  /* ---------------- rows ---------------- */
  const changeRow = (i: number, patch: Partial<Row>) => {
    setPack(null);
    setRows((rs) => refreshDefaults(rs.map((r, k) => {
      if (k !== i) return r;
      const next = { ...r, ...patch };
      if (patch.tag !== undefined && patch.tag !== r.tag) next.edited = false; // new type → fresh default line
      return next;
    })));
  };
  const addRow = () => { setPack(null); setRows((rs) => refreshDefaults([...rs, { key: rk(), tag: rs[rs.length - 1]?.tag ?? tagList[0], ratio: rs[rs.length - 1]?.ratio ?? '1:1', text: '' }])); };
  const removeRow = (i: number) => { setPack(null); setRows((rs) => refreshDefaults(rs.filter((_, k) => k !== i))); };
  const pickPack = (p: Pack) => { setPack(p.key); setRows(rowsFromPack(p)); };

  /* ---------------- AI: look at the photo, write name / points / shot lines ---------------- */
  const [aiBusy, setAiBusy] = useState(false);
  const aiFor = useRef<string>('');
  const runAi = async (what: 'all' | 'facts', quiet = false) => {
    if (!productImages.length || aiBusy) return;
    setAiBusy(true);
    try {
      const r = await api.post<{ name: string; points: string[]; shots: string[] }>('/api/assist/product', {
        assetIds: productImages.map((x) => x.id), mode,
        rows: what === 'all' && !tpl ? rows.map((x) => ({ tag: x.tag, ratio: x.ratio })) : [],
        facts: { name: facts.name.trim(), points: facts.points.map((p) => p.trim()).filter(Boolean) },
      });
      setFacts((f) => ({
        name: what === 'facts' || !f.name.trim() ? (r.name || f.name) : f.name,
        points: what === 'facts' || !f.points.some((p) => p.trim()) ? (r.points.length ? r.points : f.points) : f.points,
      }));
      if (what === 'all' && r.shots.some(Boolean)) {
        setRows((rs) => rs.map((x, i) => (r.shots[i] && (!x.edited || !quiet) ? { ...x, text: r.shots[i], edited: true } : x)));
      }
      if (!quiet) message.success(what === 'all' ? '已按这件商品写好分镜和卖点，可以直接改' : '已填好名称和卖点');
    } catch (e) {
      if (!quiet) message.warning(e instanceof ApiError ? e.message : 'AI 这次没写好，再点一次试试');
    } finally { setAiBusy(false); }
  };
  // a newly uploaded product (not the seeded one) gets an automatic first draft when nothing was typed yet
  const seededProducts = useRef(productImages.map((x) => x.id).join(','));
  useEffect(() => {
    const key = productImages.map((x) => x.id).join(',');
    if (!key || key === seededProducts.current || key === aiFor.current || tpl) return;
    aiFor.current = key;
    if (!facts.name.trim() && !facts.points.some((p) => p.trim())) void runAi('all', true);
  }, [productImages.map((x) => x.id).join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const pickImages = (us: Upload[], name?: string, points?: string[]) => {
    if (mode === 'simple') setProduct(us[0] ?? null); else setSlots([0, 1, 2].map((i) => us[i] ?? null));
    if (name || points?.length) { setFacts((f) => ({ name: name || f.name, points: points?.length ? [...points] : f.points })); aiFor.current = us.map((x) => x.id).join(','); }
  };

  const submit = async () => {
    if (blocker || busy) return;
    if (needsPoints) message.info('卖点图没有填卖点，会只画图标和引线');
    const inputs: { assetId: string; role: Role }[] = [];
    if (mode === 'simple') {
      if (product) inputs.push({ assetId: product.id, role: 'product' });
    } else {
      for (const u of filledSlots) inputs.push({ assetId: u.id, role: 'product' });
      if (modelMode !== 'none' && model) inputs.push({ assetId: model.assetId, role: 'model' });
    }
    if (style && !tpl) inputs.push({ assetId: style.id, role: mode === 'simple' ? refUse : 'style' });
    const cleanFacts = { name: facts.name.trim(), points: facts.points.map((p) => p.trim()).filter(Boolean) };
    const tplPart = tpl ? {
      templateId: tpl.id,
      templateFields: Object.fromEntries(tpl.fields.map((f) => [f.key, (tplValues[f.key] ?? '').trim().slice(0, f.max)]).filter(([, v]) => v)),
    } : {};
    const ok = await onSubmit({
      prompt: prompt.trim().slice(0, 500), tags: [], quality, inputs, ...tplPart,
      rows: planRows.map((r) => ({ ratio: r.ratio, tag: r.tag, text: r.text.trim().slice(0, 120) })),
      ...(!tpl && (cleanFacts.name || cleanFacts.points.length) ? { facts: cleanFacts } : {}),
      useStyleLock: useLock,
    });
    if (ok) setExpiredHint(false);
  };

  const setSlot = (i: number, u: Upload | null) => setSlots((ss) => ss.map((x, k) => (k === i ? u : x)));
  const addUploads = (us: Upload[], at: number) => setSlots((ss) => {
    const next = [...ss];
    const order = [at, ...[0, 1, 2].filter((k) => k !== at && !ss[k])];
    us.forEach((u, n) => { if (order[n] !== undefined) next[order[n]] = u; });
    return next;
  });
  const tagCount = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of rows) if (r.tag) m[r.tag] = (m[r.tag] ?? 0) + 1;
    return Object.entries(m).map(([t, n]) => `${TAG_LABELS[t] ?? t}${n > 1 ? ` ×${n}` : ''}`).join(' · ');
  }, [rows]);

  return (
    <div className="side">
      <div className="side-scroll">
        {tpl ? (
          <div className="tpl-note">
            <span>做同款</span><b title={tpl.title}>{tpl.title}</b>
            <button type="button" className="tpl-x" aria-label="不用这个模板" title="不用这个模板" onClick={() => setTpl(null)}><CloseOutlined /></button>
          </div>
        ) : fromTemplate && (
          <div className="tpl-note"><span>已套用模板</span><b title={fromTemplate}>{fromTemplate}</b></div>
        )}
        {project.styleLock && !tpl && <StyleLockBar thumb={project.styleLock.thumb} use={useLock} onUse={setUseLock} onUnlock={onUnlock} />}
        {expiredHint && (
          <Alert type="warning" showIcon closable onClose={() => setExpiredHint(false)} className="slim-alert" message="上次用的部分图片已超过保存期限被删除，请重新上传" />
        )}

        {/* ---------- 1 商品 ---------- */}
        <section className="step">
          <StepHead n={1} title={mode === 'simple' ? '商品' : '商品与模特'} right={mode === 'simple' ? (tpl ? '换成你的商品' : '参考图选填') : `${filledSlots.length} / 3 件`} />
          {mode === 'simple' ? (
            tpl ? (
              <UploadSlot value={product} onChange={setProduct} badge="商品" emptyTitle="上传商品图" emptyHint="拖拽或点击 · ≤15MB" style={{ height: 150 }} />
            ) : (
              <>
                <div className="ups">
                  <UploadSlot value={product} onChange={setProduct} badge="商品" emptyTitle="上传商品图"
                    emptyHint={style ? '拖拽或点击 · ≤15MB' : '可一次选 2 张，第 2 张作参考'}
                    maxFiles={style ? 1 : 2} limitText="商品图 + 参考图最多 2 张"
                    onUploadMany={(us) => { setProduct(us[0]); if (us[1]) setStyle(us[1]); }} />
                  <UploadSlot value={style} onChange={setStyle} badge={refUse === 'clone' ? '复刻' : '参考'} emptyTitle="参考图" emptyHint="选填 · 喜欢的风格或爆款图" />
                </div>
                {style && (
                  <div className="ref-use">
                    <span>参考图用来</span>
                    <Segmented size="small" value={refUse} onChange={(v) => setRefUse(v as 'style' | 'clone')}
                      options={[{ value: 'style', label: '学光线色调' }, { value: 'clone', label: '复刻整张构图' }]} />
                  </div>
                )}
              </>
            )
          ) : (
            <>
              <div className="gs">
                {slots.map((u, i) => {
                  const free = slots.filter((x, k) => !x || k === i).length;
                  return (
                    <UploadSlot key={i} value={u} onChange={(v) => setSlot(i, v)} badge={`0${i + 1}`} emptyTitle={i === 0 ? '主商品' : '搭配单品'}
                      emptyHint={i === slots.findIndex((x) => !x) && free > 1 ? `可一次选 ${free} 张` : i === 0 ? '必填' : '选填'}
                      maxFiles={free} limitText="最多 3 件商品" onUploadMany={(us) => addUploads(us, i)} />
                  );
                })}
              </div>
              <div className="sub-lbl"><span>模特</span>
                <Segmented size="small" value={modelMode} onChange={(v) => switchModelMode(v as ModelMode)}
                  options={[{ value: 'none', label: '不用' }, { value: 'ai', label: 'AI 模特' }, { value: 'mine', label: '我的模特' }]} />
              </div>
              {modelMode !== 'none' && (
                <div>
                  {modelMode === 'mine' && model && !model.source && (
                    <div className="ms-legacy">
                      {safeUrl(model.thumb) && <img src={safeUrl(model.thumb)} alt="" />}
                      <span>沿用上次的模特照片</span>
                      <button type="button" aria-label="移除" onClick={() => setModel(null)}><CloseOutlined /></button>
                    </div>
                  )}
                  <ModelSelect source={modelMode === 'ai' ? 'ai' : 'upload'} list={lib.list} loading={lib.loading} value={model?.source ? model.assetId : null}
                    onChange={pickPortrait} onNew={() => setNewModal(modelMode === 'ai' ? 'ai' : 'upload')} />
                </div>
              )}
              {!tpl && (
                <div className="sub-lbl"><span>风格参考</span><small>选填</small></div>
              )}
              {!tpl && <UploadSlot value={style} onChange={setStyle} badge="风格参考" emptyTitle="上传一张喜欢的风格图" style={{ height: 84 }} />}
            </>
          )}
          {!tpl && <FactsPanel facts={facts} onChange={setFacts} images={productImages} onPickImages={pickImages} onAi={() => void runAi('facts')} aiBusy={aiBusy} />}
        </section>

        {/* ---------- 2 要哪些图 ---------- */}
        <section className="step">
          <StepHead n={2} title="要哪些图" right={tpl ? `${total} 张` : (
            <Tooltip title={productImages.length ? 'AI 看商品图，为每张写好怎么拍' : '先上传商品图'}>
              <button type="button" className="ai-btn" onClick={() => void runAi('all')} disabled={aiBusy || !productImages.length}>
                {aiBusy ? <Spin size="small" /> : <ThunderboltOutlined />}AI 写分镜
              </button>
            </Tooltip>
          )} />
          {tpl ? (
            <>
              {tpl.fields.length > 0 && (
                <div className="tpl-fields">
                  {tpl.fields.map((f) => (
                    <label key={f.key} className="tpl-field">
                      <span>{f.label}</span>
                      <Input value={tplValues[f.key] ?? ''} maxLength={f.max} placeholder={f.placeholder || '留空就不写'}
                        onChange={(e) => setTplValues((v) => ({ ...v, [f.key]: e.target.value }))} />
                    </label>
                  ))}
                </div>
              )}
              <div className="pills">
                {RATIO_OPTIONS.filter((r) => opts.ratios.includes(r.value)).map((r) => {
                  const k = 12 / Math.max(r.w, r.h);
                  return (
                    <button key={r.value} type="button" className={`pill${tplRatio === r.value ? ' on' : ''}`} onClick={() => setTplRatio(r.value)} aria-pressed={tplRatio === r.value}>
                      <span className="top"><i style={{ width: Math.round(r.w * k), height: Math.round(r.h * k) }} />{r.value}</span><small>{r.label}</small>
                    </button>
                  );
                })}
              </div>
              <div className="line">
                <span>张数</span>
                <div className="num">
                  <button type="button" onClick={() => setTplCount((n) => Math.max(1, n - 1))} disabled={tplCount <= 1} aria-label="减少">−</button>
                  <span>{tplCount}</span>
                  <button type="button" onClick={() => setTplCount((n) => Math.min(Math.min(4, max), n + 1))} disabled={tplCount >= Math.min(4, max)} aria-label="增加">+</button>
                </div>
              </div>
            </>
          ) : (
            <>
              <PackRow packs={packs} value={pack} onPick={pickPack} />
              <div className="rows-sum"><span>{total} 张</span><small>{tagCount}</small></div>
              <RowsEditor rows={rows} tagList={tagList} ratioList={ratioList} max={max} onChange={changeRow} onAdd={addRow} onRemove={removeRow} />
              {needsPoints && <p className="hint-p">有卖点图，记得在第 1 步填卖点（或点「AI 识别」）。</p>}
            </>
          )}
        </section>

        {/* ---------- 3 补充 ---------- */}
        <section className="step">
          <StepHead n={3} title="补充要求" right="都可以不填" />
          <div className="box">
            <Input.TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={500} autoSize={{ minRows: 2, maxRows: 5 }}
              placeholder={tpl ? '比如：整体偏暖一点，背景换成浅粉色' : mode === 'simple' ? '对整套图的要求，比如：高级感，米色系，不要花哨' : '比如：秋天的感觉，自然一点'} />
            {prompt.length > 0 && <span className="hint">{prompt.length} / 500</span>}
          </div>
          {!tpl && <BrandPanel brand={project.brand} onSave={onBrand} />}
          <div className="line">
            <span>画质</span>
            <Segmented size="small" value={quality} onChange={(v) => setQuality(v as Quality)} options={[{ value: 'standard', label: `标准 · ${opts.prices.standard} 积分/张` }, { value: 'hd', label: `高清 · ${opts.prices.hd} 积分/张` }]} />
          </div>
        </section>
      </div>

      <AiModelCreate open={newModal === 'ai'} onClose={() => setNewModal(null)} onSaved={(p) => { lib.upsert(p); pickPortrait(p); }} />
      <UploadModelModal open={newModal === 'upload'} onClose={() => setNewModal(null)} onSaved={(p) => { lib.upsert(p); pickPortrait(p); }} />
      <div className="side-foot">
        <div className="cost">
          <span>将消耗 <b>{cost}</b> 积分 · 余额 {credits.toLocaleString('zh-CN')}</span>
          {blocker && <span className="warn">{blocker}</span>}
        </div>
        <button className="go" onClick={submit} disabled={!!blocker || busy}>
          {busy ? <Spin size="small" /> : null}
          生成 {total} 张<em>{cost} 积分</em>
        </button>
      </div>
    </div>
  );
}
