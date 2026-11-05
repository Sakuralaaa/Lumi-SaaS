import { useEffect, useState } from 'react';
import { App, Button, ColorPicker, Input, Modal, Segmented, Select, Spin, Switch, Tooltip } from 'antd';
import { BgColorsOutlined, CloseOutlined, DownOutlined, LinkOutlined, LockOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import type { Brand, Facts, Product, Row, Upload } from '../api/types';
import { FONTS, LANGS, TAG_LABELS, TEXT_TAGS, type Pack } from '../lib/labels';
import { useErrorToast } from '../lib/notify';

/* ------------------------------------------------------------------ 商品资料：名称 + 卖点 + 商品库 + 链接导入 */
export function FactsPanel({ facts, onChange, images, onPickImages, onAi, aiBusy }: {
  facts: Facts; onChange: (f: Facts) => void; images: Upload[]; onPickImages: (us: Upload[], name?: string, points?: string[]) => void;
  onAi?: () => void; aiBusy?: boolean;
}) {
  const [lib, setLib] = useState(false);
  const [link, setLink] = useState(false);
  const { message } = App.useApp();
  const toast = useErrorToast();
  const [saving, setSaving] = useState(false);
  const setPoint = (i: number, v: string) => onChange({ ...facts, points: facts.points.map((p, k) => (k === i ? v : p)) });
  const points = facts.points.length ? facts.points : [''];

  const save = async () => {
    if (!facts.name.trim()) { message.info('先填一个商品名称'); return; }
    if (!images.length) { message.info('先上传商品图'); return; }
    setSaving(true);
    try {
      await api.post<Product>('/api/products', { name: facts.name.trim(), points: facts.points.map((p) => p.trim()).filter(Boolean), assetIds: images.map((x) => x.id) });
      message.success('已存入商品库，下次直接选');
    } catch (e) { toast(e); } finally { setSaving(false); }
  };

  return (
    <div>
      <div className="lbl">
        <span>商品资料</span>
        <span className="r fx-acts">
          {onAi && <button type="button" className="ai" onClick={onAi} disabled={aiBusy || !images.length} title={images.length ? 'AI 看图写名称和卖点' : '先上传商品图'}>
            {aiBusy ? <Spin size="small" /> : <ThunderboltOutlined />}AI 识别</button>}
          <button type="button" onClick={() => setLink(true)}><LinkOutlined />粘贴链接</button>
          <button type="button" onClick={() => setLib(true)}>商品库</button>
          <button type="button" onClick={save} disabled={saving}>{saving ? '保存中' : '存入'}</button>
        </span>
      </div>
      <div className="facts">
        <Input value={facts.name} maxLength={30} placeholder="商品名称，比如：玻尿酸保湿精华" onChange={(e) => onChange({ ...facts, name: e.target.value })} />
        {points.map((p, i) => (
          <div className="pt" key={i}>
            <Input value={p} maxLength={24} placeholder={i === 0 ? '卖点，比如：深层补水' : '再加一条卖点'} onChange={(e) => setPoint(i, e.target.value)}
              onBlur={() => facts.points.length > 1 && !p.trim() && onChange({ ...facts, points: facts.points.filter((_, k) => k !== i) })} />
            {facts.points.length > 1 && <button type="button" aria-label="删除这条" onClick={() => onChange({ ...facts, points: facts.points.filter((_, k) => k !== i) })}><CloseOutlined /></button>}
          </div>
        ))}
        {points.length < 5 && points[points.length - 1]?.trim() && (
          <button type="button" className="pt-add" onClick={() => onChange({ ...facts, points: [...points, ''] })}><PlusOutlined /> 加一条卖点</button>
        )}
        <small className="fx-note">卖点会印在「卖点图」「A+ 图」上，也帮其它图突出重点。上传商品图后 AI 会先帮你填，可以直接改。</small>
      </div>
      <ProductLibraryModal open={lib} onClose={() => setLib(false)} onPick={(p) => { onPickImages(p.images, p.name, p.points); setLib(false); }} />
      <LinkImportModal open={link} onClose={() => setLink(false)} onPick={(us, title) => { onPickImages(us, title); setLink(false); }} />
    </div>
  );
}

function ProductLibraryModal({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (p: Product) => void }) {
  const [list, setList] = useState<Product[] | null>(null);
  const toast = useErrorToast();
  useEffect(() => {
    if (!open) return;
    setList(null);
    api.get<Product[]>('/api/products').then(setList).catch((e) => { toast(e); setList([]); });
  }, [open, toast]);
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="从商品库选择" width={560} destroyOnHidden>
      {!list ? <div className="center-pad"><Spin /></div> : !list.length ? (
        <p className="muted-p">商品库还是空的。填好商品名称、上传商品图后点「存入」，下次就能直接选。</p>
      ) : (
        <div className="plib">
          {list.map((p) => (
            <button type="button" key={p.id} className="plib-i" onClick={() => onPick(p)} disabled={!p.images.length}>
              {safeUrl(p.images[0]?.thumb) ? <img src={safeUrl(p.images[0]?.thumb)} alt="" /> : <span className="ph" />}
              <b>{p.name}</b>
              <small>{p.points.slice(0, 2).join(' · ') || `${p.images.length} 张图`}</small>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

function LinkImportModal({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (us: Upload[], title: string) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ title: string; images: Upload[] } | null>(null);
  const [sel, setSel] = useState<string[]>([]);
  const toast = useErrorToast();
  useEffect(() => { if (open) { setRes(null); setSel([]); } }, [open]);
  const go = async () => {
    if (!url.trim()) return;
    setBusy(true);
    try {
      const r = await api.post<{ title: string; images: Upload[] }>('/api/import/link', { url: url.trim() });
      setRes(r); setSel(r.images.slice(0, 1).map((x) => x.id));
    } catch (e) { toast(e); } finally { setBusy(false); }
  };
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : s.length >= 3 ? s : [...s, id]));
  return (
    <Modal open={open} onCancel={onClose} title="粘贴商品链接" width={560} destroyOnHidden
      okText="用这几张" cancelText="取消" okButtonProps={{ disabled: !res || !sel.length }}
      onOk={() => res && onPick(res.images.filter((x) => sel.includes(x.id)), res.title)}>
      <div className="link-row">
        <Input value={url} onChange={(e) => setUrl(e.target.value)} onPressEnter={go} placeholder="粘贴商品页链接或分享文字" allowClear />
        <Button onClick={go} loading={busy} type="primary">读取</Button>
      </div>
      {res ? (
        <>
          {res.title && <p className="link-title">{res.title}</p>}
          <div className="link-grid">
            {res.images.map((x) => (
              <button type="button" key={x.id} className={sel.includes(x.id) ? 'on' : ''} onClick={() => toggle(x.id)}>
                {safeUrl(x.thumb) && <img src={safeUrl(x.thumb)} alt="" />}
                {sel.includes(x.id) && <em>{sel.indexOf(x.id) + 1}</em>}
              </button>
            ))}
          </div>
          <small className="fx-note">点选要用的商品图，第一张作为主商品。</small>
        </>
      ) : <small className="fx-note">支持多数独立站和公开商品页。淘宝、天猫等需要登录的平台可能读不到，可以先保存图片再上传。</small>}
    </Modal>
  );
}

/* ------------------------------------------------------------------ 步骤标题 */
export function StepHead({ n, title, right }: { n: number; title: string; right?: React.ReactNode }) {
  return (
    <div className="step-hd">
      <i>{n}</i><b>{title}</b>{right ? <span className="r">{right}</span> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ 套餐：一键得到一组分镜 */
export function PackRow({ packs, value, onPick }: { packs: Pack[]; value: string | null; onPick: (p: Pack) => void }) {
  return (
    <div className="packs" role="group" aria-label="套餐">
      {packs.map((p) => (
        <Tooltip key={p.key} title={p.hint}>
          <button type="button" className={value === p.key ? 'on' : ''} aria-pressed={value === p.key} onClick={() => onPick(p)}>
            {p.label}<small>{p.rows.length} 张</small>
          </button>
        </Tooltip>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ 分镜：每张图一行（类型 + 比例 + 怎么拍） */
export function RowsEditor({ rows, tagList, ratioList, max, onChange, onAdd, onRemove }: {
  rows: Row[]; tagList: string[]; ratioList: string[]; max: number;
  onChange: (i: number, patch: Partial<Row>) => void; onAdd: () => void; onRemove: (i: number) => void;
}) {
  const tagOpts = tagList.map((t) => ({ value: t, label: TAG_LABELS[t] ?? t }));
  const ratioOpts = ratioList.map((r) => ({ value: r, label: r }));
  return (
    <div>
      <ol className="rows">
        {rows.map((r, i) => (
          <li key={r.key}>
            <div className="row-hd">
              <span className="no">{String(i + 1).padStart(2, '0')}</span>
              <Select size="small" variant="borderless" className="row-tag" value={r.tag ?? undefined} options={tagOpts} popupMatchSelectWidth={false}
                onChange={(v) => onChange(i, { tag: v })} aria-label="图片类型" />
              <Select size="small" variant="borderless" className="row-ratio" value={r.ratio} options={ratioOpts} popupMatchSelectWidth={false}
                onChange={(v) => onChange(i, { ratio: v })} aria-label="比例" />
              {TEXT_TAGS.includes(r.tag ?? '') && <span className="row-badge">印卖点</span>}
              {rows.length > 1 && <button type="button" className="row-x" aria-label="删掉这张" title="删掉这张" onClick={() => onRemove(i)}><CloseOutlined /></button>}
            </div>
            <Input.TextArea variant="borderless" value={r.text} maxLength={120} autoSize={{ minRows: 1, maxRows: 3 }} placeholder="这张想怎么拍，比如：放在木桌上，清晨窗边光"
              onChange={(e) => onChange(i, { text: e.target.value, edited: true })} />
          </li>
        ))}
      </ol>
      {rows.length < max && <button type="button" className="row-add" onClick={onAdd}><PlusOutlined /> 加一张</button>}
    </div>
  );
}

/* ------------------------------------------------------------------ 品牌设置（项目级，保存后每批沿用） */
export function BrandPanel({ brand, onSave }: { brand: Brand | null | undefined; onSave: (b: Brand | null) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Brand>(() => ({ ...(brand ?? {}) }));
  const [busy, setBusy] = useState(false);
  useEffect(() => { setV({ ...(brand ?? {}) }); }, [brand]);
  const summary = [brand?.color ? '品牌色' : '', brand?.font ? FONTS.find((f) => f.value === brand.font)?.label : '', brand?.lang && brand.lang !== 'zh' ? LANGS.find((l) => l.value === brand.lang)?.label : '']
    .filter(Boolean).join(' · ');
  const save = async () => { setBusy(true); try { await onSave(v.color || v.font || (v.lang && v.lang !== 'zh') || v.note?.trim() ? v : null); setOpen(false); } finally { setBusy(false); } };
  return (
    <div className="bset">
      <button type="button" className="bset-hd" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {brand?.color ? <i className="sw" style={{ background: brand.color }} /> : <BgColorsOutlined />}
        <span>品牌设置</span>
        <small>{summary || '未设置 · 选填'}</small>
        <DownOutlined className={open ? 'rot' : ''} />
      </button>
      {open && (
        <div className="bset-bd">
          <label><span>品牌色</span>
            <div className="sw-row">
              {BRAND_SWATCHES.map((c) => <button key={c} type="button" className={`sw${v.color === c ? ' on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setV((x) => ({ ...x, color: x.color === c ? null : c }))} />)}
              <ColorPicker size="small" value={v.color ?? undefined} onChangeComplete={(c) => setV((x) => ({ ...x, color: c.toHexString().slice(0, 7) }))} disabledAlpha />
            </div>
          </label>
          <label><span>图上字体</span>
            <Segmented block size="small" value={v.font ?? 'none'} onChange={(x) => setV((y) => ({ ...y, font: x === 'none' ? null : (x as Brand['font']) }))}
              options={[{ value: 'none', label: '自动' }, ...FONTS]} />
          </label>
          <label><span>图上文字</span>
            <Select size="small" value={v.lang ?? 'zh'} options={LANGS} onChange={(x) => setV((y) => ({ ...y, lang: x }))} style={{ width: 140 }} />
            <small>卖点图、A+ 图会自动翻译成这个语言</small>
          </label>
          <label><span>品牌调性</span>
            <Input size="small" value={v.note ?? ''} maxLength={60} placeholder="比如：日系清新、干净克制" onChange={(e) => setV((x) => ({ ...x, note: e.target.value }))} />
          </label>
          <div className="bset-ft">
            <button type="button" className="lnk" onClick={() => setV({})}>清空</button>
            <Button size="small" type="primary" loading={busy} onClick={save}>保存，之后每批都沿用</Button>
          </div>
        </div>
      )}
    </div>
  );
}
const BRAND_SWATCHES = ['#b5492f', '#1f3a5f', '#2f6b4f', '#c8a24a', '#e7a1b0', '#111111'];

/* ------------------------------------------------------------------ 风格锁 */
export function StyleLockBar({ thumb, use, onUse, onUnlock }: { thumb: string | null; use: boolean; onUse: (v: boolean) => void; onUnlock: () => void }) {
  return (
    <div className="lockbar">
      {safeUrl(thumb) ? <img src={safeUrl(thumb)} alt="" /> : <span className="ic"><LockOutlined /></span>}
      <div className="tx"><b>风格已锁定</b><small>{use ? '这一批会沿用同样的光线和色调' : '这一批暂不沿用'}</small></div>
      <Switch size="small" checked={use} onChange={onUse} aria-label="沿用锁定的风格" />
      <button type="button" className="lnk" onClick={onUnlock}>解锁</button>
    </div>
  );
}
