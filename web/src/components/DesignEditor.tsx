import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { App, Button, ColorPicker, Input, InputNumber, Modal, Popover, Segmented, Slider, Spin, Tooltip } from 'antd';
import {
  AppstoreAddOutlined, BgColorsOutlined, BorderOutlined, CopyOutlined, DeleteOutlined, EyeInvisibleOutlined, EyeOutlined,
  FontSizeOutlined, PictureOutlined, RedoOutlined, ScissorOutlined, UndoOutlined, VerticalAlignBottomOutlined, VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { Stage, Layer as KLayer, Image as KImage, Text as KText, Rect as KRect, Transformer, Line } from 'react-konva';
import type Konva from 'konva';
import '@fontsource/zcool-kuaile/400.css';
import '@fontsource/zcool-qingke-huangyou/400.css';
import '@fontsource/ma-shan-zheng/400.css';
import { api, safeUrl } from '../api/client';
import type { Item, Upload } from '../api/types';
import { useErrorToast } from '../lib/notify';
import { useIsMobile } from '../lib/useMobile';

type FontKey = 'sans' | 'serif' | 'kuaile' | 'huangyou' | 'brush';
interface Base { type: string; id: string; x: number; y: number; rot: number; opacity: number; hidden: boolean }
export interface TextL extends Base { type: 'text'; text: string; font: FontKey; size: number; color: string; weight: 400 | 700 | 900; align: 'left' | 'center' | 'right'; width: number; stroke: string | null; strokeW: number; shadow: boolean; spacing: number; lineHeight: number }
export interface RectL extends Base { type: 'rect'; w: number; h: number; fill: string; radius: number }
export interface ImageL extends Base { type: 'image'; assetId: string; w: number; h: number; role: 'product' | 'logo' | 'sticker'; shadow: boolean }
type L = TextL | RectL | ImageL;
interface Doc { v: 1; w: number; h: number; layers: L[] }
interface Loaded { itemId: string; base: { assetId: string; url: string; width: number; height: number }; doc: Doc | null; assets: Record<string, string>; products: { assetId: string; thumb: string }[]; matting: boolean }

const FAMILY: Record<FontKey, string> = {
  sans: '"Noto Sans SC Variable", "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: '"Noto Serif SC", "Songti SC", serif',
  kuaile: '"ZCOOL KuaiLe", "Noto Sans SC Variable", sans-serif',
  huangyou: '"ZCOOL QingKe HuangYou", "Noto Sans SC Variable", sans-serif',
  brush: '"Ma Shan Zheng", "Noto Serif SC", serif',
};
const FONT_OPTS: { value: FontKey; label: string }[] = [
  { value: 'sans', label: '黑体' }, { value: 'serif', label: '宋体' }, { value: 'huangyou', label: '黄油体' }, { value: 'kuaile', label: '快乐体' }, { value: 'brush', label: '毛笔' },
];
const SWATCHES = ['#ffffff', '#111111', '#b5492f', '#c8a24a', '#1f3a5f', '#e7a1b0', '#2f6b4f'];
let seq = 0;
const nid = () => `l${Date.now().toString(36)}${(++seq).toString(36)}`;
const LAYER_NAMES: Record<string, string> = { text: '文字', rect: '色块', product: '商品', logo: 'Logo', sticker: '图片' };

function useImage(url: string | null | undefined) {
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  useEffect(() => {
    if (!url) { setImg(null); return; }
    const im = new window.Image(); im.crossOrigin = 'use-credentials';
    im.onload = () => setImg(im); im.onerror = () => setImg(null); im.src = url;
    return () => { im.onload = null; };
  }, [url]);
  return img;
}

function LayerImage({ l, url, common, onReady }: { l: ImageL; url?: string; common: any; onReady: () => void }) {
  const img = useImage(url);
  useEffect(() => { if (img) onReady(); }, [img]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!img) return null;
  return <KImage {...common} image={img} width={l.w} height={l.h}
    shadowEnabled={l.shadow} shadowColor="rgba(0,0,0,0.45)" shadowBlur={Math.max(l.w, l.h) * 0.05} shadowOffsetY={Math.max(l.w, l.h) * 0.02} shadowOpacity={0.6} />;
}

export default function DesignEditor({ item, open, onClose, onSaved, brandColor }: {
  item: Item | null; open: boolean; onClose: () => void; onSaved: (r: { id: string; reserved: number }) => void; brandColor?: string | null;
}) {
  const { message } = App.useApp();
  const toast = useErrorToast();
  const mobile = useIsMobile();
  const [data, setData] = useState<Loaded | null>(null);
  const [layers, setLayers] = useState<L[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [past, setPast] = useState<L[][]>([]);
  const [future, setFuture] = useState<L[][]>([]);
  const [busy, setBusy] = useState(false);
  const [cutting, setCutting] = useState(false);
  const [menu, setMenu] = useState<'text' | 'prod' | null>(null);
  const [boxW, setBoxW] = useState(0);
  const [boxH, setBoxH] = useState(0);
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false });
  const [tick, setFontTick] = useState(0);
  const [assetUrls, setAssetUrls] = useState<Record<string, string>>({});
  const stageRef = useRef<Konva.Stage>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // load
  useEffect(() => {
    if (!open || !item) return;
    setData(null); setLayers([]); setSel(null); setPast([]); setFuture([]);
    let off = false;
    api.get<Loaded>(`/api/items/${item.id}/design`).then((d) => {
      if (off) return;
      setData(d); setAssetUrls(d.assets ?? {});
      if (d.doc?.layers?.length) setLayers(d.doc.layers);
      else {
        const W = d.base.width;
        const t: TextL = { type: 'text', id: nid(), text: '你的标题', font: 'sans', size: Math.round(W * 0.07), color: '#111111', weight: 900, align: 'center',
          width: Math.round(W * 0.8), x: Math.round(W * 0.1), y: Math.round(d.base.height * 0.07), rot: 0, opacity: 1, hidden: false, stroke: null, strokeW: 0, shadow: false, spacing: 0, lineHeight: 1.2 };
        setLayers([t]); setSel(t.id);
      }
    }).catch((e) => { toast(e); onClose(); });
    return () => { off = true; };
  }, [open, item?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // fit
  useEffect(() => {
    if (!open) return;
    const el = boxRef.current; if (!el) return;
    const ro = new ResizeObserver(() => { setBoxW(el.clientWidth); setBoxH(el.clientHeight); });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, data]);

  // fonts: redraw once each face used is loaded
  useEffect(() => {
    const need = new Set(layers.filter((l): l is TextL => l.type === 'text').map((l) => `${l.weight} 40px ${FAMILY[l.font].split(',')[0]}`));
    let off = false;
    Promise.all([...need].map((f) => document.fonts.load(f, '中文字体Aa1').catch(() => null))).then(() => { if (!off) { setFontTick((t) => t + 1); stageRef.current?.batchDraw(); } });
    return () => { off = true; };
  }, [layers]);

  const baseImg = useImage(data?.base.url ? safeUrl(data.base.url) : null);
  const W = data?.base.width ?? 1, H = data?.base.height ?? 1;
  const scale = boxW && boxH ? Math.min(boxW / W, boxH / H) : 0;
  const cur = layers.find((l) => l.id === sel) ?? null;

  // history
  const commit = useCallback((next: L[] | ((ls: L[]) => L[])) => {
    setLayers((ls) => {
      const n = typeof next === 'function' ? next(ls) : next;
      if (n !== ls) { setPast((p) => [...p.slice(-49), ls]); setFuture([]); }
      return n;
    });
  }, []);
  const patch = (id: string, p: Partial<L>) => commit((ls) => ls.map((l) => (l.id === id ? ({ ...l, ...p } as L) : l)));
  const undo = () => { if (!past.length) return; setFuture((f) => [layers, ...f]); setLayers(past[past.length - 1]); setPast((p) => p.slice(0, -1)); };
  const redo = () => { if (!future.length) return; setPast((p) => [...p, layers]); setLayers(future[0]); setFuture((f) => f.slice(1)); };

  // transformer
  useEffect(() => {
    const tr = trRef.current, st = stageRef.current;
    if (!tr || !st) return;
    const node = sel ? st.findOne(`#${sel}`) : null;
    tr.nodes(node && !cur?.hidden ? [node] : []);
    tr.getLayer()?.batchDraw();
  }, [sel, layers, scale, cur?.hidden, tick]);

  // keyboard
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
      if (!cur) return;
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); remove(); return; }
      const step = (e.shiftKey ? 10 : 1) / (scale || 1);
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      if (d[e.key]) { e.preventDefault(); patch(cur.id, { x: Math.round(cur.x + d[e.key][0]), y: Math.round(cur.y + d[e.key][1]) }); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- add ----
  const addText = (kind: 'title' | 'sub' | 'tag' | 'corner') => {
    setMenu(null);
    const accent = brandColor || '#b5492f';
    const base: Omit<TextL, 'text' | 'size' | 'color' | 'weight' | 'y'> = { type: 'text', id: nid(), font: 'sans', align: 'center', width: Math.round(W * 0.8), x: Math.round(W * 0.1), rot: 0, opacity: 1, hidden: false, stroke: null, strokeW: 0, shadow: false, spacing: 0, lineHeight: 1.2 };
    const out: L[] = [];
    if (kind === 'title') out.push({ ...base, text: '主标题', size: Math.round(W * 0.075), color: '#111111', weight: 900, y: Math.round(H * 0.08) });
    if (kind === 'sub') out.push({ ...base, text: '一句副标题说清卖点', size: Math.round(W * 0.038), color: '#333333', weight: 400, y: Math.round(H * 0.18), spacing: 2 });
    if (kind === 'tag' || kind === 'corner') {
      const fs = Math.round(W * (kind === 'tag' ? 0.034 : 0.04));
      const txt = kind === 'tag' ? '卖点标签' : '新品';
      const tw = Math.round(fs * (txt.length + 1.6)), th = Math.round(fs * 1.9);
      const x = kind === 'tag' ? Math.round((W - tw) / 2) : Math.round(W * 0.05), y = kind === 'tag' ? Math.round(H * 0.82) : Math.round(H * 0.05);
      out.push({ type: 'rect', id: nid(), x, y, w: tw, h: th, fill: accent, radius: kind === 'tag' ? th / 2 : Math.round(fs * 0.25), rot: 0, opacity: 1, hidden: false });
      out.push({ ...base, text: txt, size: fs, color: '#ffffff', weight: 700, width: tw, x, y: Math.round(y + (th - fs * 1.2) / 2) });
    }
    commit((ls) => [...ls, ...out]); setSel(out[out.length - 1].id);
  };
  const addRect = () => {
    const r: RectL = { type: 'rect', id: nid(), x: Math.round(W * 0.1), y: Math.round(H * 0.7), w: Math.round(W * 0.8), h: Math.round(H * 0.18), fill: '#ffffff', radius: Math.round(W * 0.02), rot: 0, opacity: 0.85, hidden: false };
    commit((ls) => [...ls, r]); setSel(r.id);
  };
  const placeImage = (u: { id: string; width: number; height: number; url: string }, role: ImageL['role']) => {
    const maxSide = role === 'logo' ? 0.18 : role === 'product' ? 0.55 : 0.3;
    const f = Math.min((W * maxSide) / u.width, (H * maxSide) / u.height);
    const w = Math.round(u.width * f), h = Math.round(u.height * f);
    const l: ImageL = { type: 'image', id: nid(), assetId: u.id, role, w, h, x: role === 'logo' ? Math.round(W * 0.05) : Math.round((W - w) / 2), y: role === 'logo' ? Math.round(H * 0.05) : Math.round((H - h) / 2), rot: 0, opacity: 1, hidden: false, shadow: role === 'product' };
    setAssetUrls((m) => ({ ...m, [u.id]: u.url }));
    commit((ls) => [...ls, l]); setSel(l.id);
  };
  const cutProduct = async (assetId: string) => {
    setMenu(null); setCutting(true);
    try {
      const r = await api.post<{ id: string; width: number; height: number; url: string }>(`/api/assets/${assetId}/cutout`, {});
      placeImage(r, 'product');
    } catch (e) { toast(e); } finally { setCutting(false); }
  };
  const uploadImage = async (f: File) => {
    try {
      const u = await api.upload<Upload>('/api/uploads', f);
      placeImage({ id: u.id, width: u.width, height: u.height, url: u.url ?? u.thumb ?? '' }, /logo/i.test(f.name) ? 'logo' : 'sticker');
    } catch (e) { toast(e); }
  };

  // ---- edit ----
  const remove = () => { if (!cur) return; commit((ls) => ls.filter((l) => l.id !== cur.id)); setSel(null); };
  const duplicate = () => {
    if (!cur) return;
    const c = { ...cur, id: nid(), x: cur.x + Math.round(W * 0.03), y: cur.y + Math.round(W * 0.03) } as L;
    commit((ls) => [...ls, c]); setSel(c.id);
  };
  const move = (dir: 1 | -1) => {
    if (!cur) return;
    commit((ls) => {
      const i = ls.findIndex((l) => l.id === cur.id), j = i + dir;
      if (j < 0 || j >= ls.length) return ls;
      const n = [...ls]; [n[i], n[j]] = [n[j], n[i]]; return n;
    });
  };

  const onDragMove = (e: Konva.KonvaEventObject<DragEvent>, l: L) => {
    const node = e.target;
    const box = node.getClientRect({ relativeTo: node.getLayer() as any });
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    const tol = 6 / (scale || 1);
    let v = false, h = false;
    if (Math.abs(cx - W / 2) < tol) { node.x(node.x() + (W / 2 - cx)); v = true; }
    if (Math.abs(cy - H / 2) < tol) { node.y(node.y() + (H / 2 - cy)); h = true; }
    if (v !== guides.v || h !== guides.h) setGuides({ v, h });
    void l;
  };
  const onDragEnd = (e: Konva.KonvaEventObject<DragEvent>, l: L) => { setGuides({ v: false, h: false }); patch(l.id, { x: Math.round(e.target.x()), y: Math.round(e.target.y()) }); };
  const onTransformEnd = (e: Konva.KonvaEventObject<Event>, l: L) => {
    const n = e.target; const sx = n.scaleX(), sy = n.scaleY();
    n.scaleX(1); n.scaleY(1);
    const common = { x: Math.round(n.x()), y: Math.round(n.y()), rot: Math.round(n.rotation() * 10) / 10 };
    if (l.type === 'text') {
      const k = Math.abs(sy - 1) > 0.01 ? sy : 1;
      patch(l.id, { ...common, size: Math.max(4, Math.round(l.size * k)), width: Math.max(10, Math.round(n.width() * sx)) });
    } else patch(l.id, { ...common, w: Math.max(4, Math.round(l.w * sx)), h: Math.max(4, Math.round(l.h * sy)) });
  };

  const save = async () => {
    const st = stageRef.current; if (!st || !item || !data || !scale) return;
    const texts = layers.filter((l): l is TextL => l.type === 'text' && !l.hidden).map((l) => l.text.trim());
    if (!layers.some((l) => !l.hidden)) { message.info('先加点东西'); return; }
    if (texts.some((t) => !t)) { message.info('有一段文字是空的，填上或删掉它'); return; }
    setBusy(true);
    try {
      setSel(null); trRef.current?.nodes([]); setGuides({ v: false, h: false });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      await document.fonts.ready;
      const url = st.toDataURL({ pixelRatio: 1 / scale, mimeType: 'image/jpeg', quality: 0.93, x: 0, y: 0, width: W * scale, height: H * scale });
      const blob = await (await fetch(url)).blob();
      const up = await api.upload<Upload>('/api/uploads', new File([blob], 'design.jpg', { type: 'image/jpeg' }));
      const r = await api.post<{ id: string; reserved: number }>(`/api/items/${item.id}/overlay`, { assetId: up.id, design: { v: 1, w: W, h: H, layers } });
      message.success('已保存为新版本，图层可随时再改');
      onSaved(r); onClose();
    } catch (e) {
      if (e instanceof DOMException) message.error('这张图暂时无法导出，请刷新页面后再试'); else toast(e);
    } finally { setBusy(false); }
  };

  const productMenu = useMemo(() => data && (
    <div className="dz-prods">
      <p>抠出商品原图，作为可拖动的图层</p>
      <div className="dz-prod-grid">
        {data.products.map((p) => (
          <button key={p.assetId} type="button" onClick={() => cutProduct(p.assetId)} disabled={cutting}><img src={safeUrl(p.thumb) ?? undefined} alt="" /></button>
        ))}
        <button type="button" className="dz-self" onClick={() => cutProduct(data.base.assetId)} disabled={cutting}><ScissorOutlined /><small>从这张图抠</small></button>
      </div>
    </div>
  ), [data, cutting]); // eslint-disable-line react-hooks/exhaustive-deps

  const textMenu = (
    <div className="dz-presets">
      <button type="button" onClick={() => addText('title')}><b style={{ fontSize: 18 }}>主标题</b></button>
      <button type="button" onClick={() => addText('sub')}><span>副标题</span></button>
      <button type="button" onClick={() => addText('tag')}><span className="pill-demo" style={{ background: brandColor || 'var(--accent)' }}>卖点标签</span></button>
      <button type="button" onClick={() => addText('corner')}><span className="corner-demo" style={{ background: brandColor || 'var(--accent)' }}>角标</span></button>
    </div>
  );

  const render = (l: L) => {
    if (l.hidden) return null;
    const common = {
      id: l.id, x: l.x, y: l.y, rotation: l.rot, opacity: l.opacity, draggable: true,
      onMouseDown: () => setSel(l.id), onTouchStart: () => setSel(l.id),
      onDragStart: () => setSel(l.id), onDragMove: (e: any) => onDragMove(e, l), onDragEnd: (e: any) => onDragEnd(e, l), onTransformEnd: (e: any) => onTransformEnd(e, l),
    };
    if (l.type === 'text') return (
      <KText key={l.id} {...common} text={l.text || ' '} fontFamily={FAMILY[l.font]} fontSize={l.size} fontStyle={String(l.weight)} fill={l.color} align={l.align}
        width={l.width} letterSpacing={l.spacing} lineHeight={l.lineHeight} wrap="char"
        stroke={l.stroke && l.strokeW ? l.stroke : undefined} strokeWidth={l.stroke ? l.strokeW : 0} fillAfterStrokeEnabled
        shadowEnabled={l.shadow} shadowColor="rgba(0,0,0,0.45)" shadowBlur={l.size * 0.25} shadowOffsetY={l.size * 0.06} />
    );
    if (l.type === 'rect') return <KRect key={l.id} {...common} width={l.w} height={l.h} fill={l.fill} cornerRadius={Math.min(l.radius, l.w / 2, l.h / 2)} />;
    return <LayerImage key={l.id} l={l} url={safeUrl(assetUrls[l.assetId]) ?? undefined} common={common} onReady={() => setFontTick((t) => t + 1)} />;
  };

  const props = cur && (
    <div className="dz-props">
      <div className="dz-ph">
        <b>{cur.type === 'image' ? LAYER_NAMES[cur.role] : LAYER_NAMES[cur.type]}</b>
        <span>
          <Tooltip title="复制"><button type="button" onClick={duplicate}><CopyOutlined /></button></Tooltip>
          <Tooltip title="上移一层"><button type="button" onClick={() => move(1)}><VerticalAlignTopOutlined /></button></Tooltip>
          <Tooltip title="下移一层"><button type="button" onClick={() => move(-1)}><VerticalAlignBottomOutlined /></button></Tooltip>
          <Tooltip title="删除"><button type="button" className="danger" onClick={remove}><DeleteOutlined /></button></Tooltip>
        </span>
      </div>
      {cur.type === 'text' && (<>
        <Input.TextArea value={cur.text} maxLength={60} autoSize={{ minRows: 2, maxRows: 4 }} onChange={(e) => patch(cur.id, { text: e.target.value })} placeholder="输入文字" />
        <div className="dz-row"><span>字体</span>
          <div className="dz-fonts">{FONT_OPTS.map((f) => (
            <button key={f.value} type="button" className={cur.font === f.value ? 'on' : ''} style={{ fontFamily: FAMILY[f.value] }} onClick={() => patch(cur.id, { font: f.value })}>{f.label}</button>
          ))}</div>
        </div>
        <div className="dz-row"><span>字号</span><Slider min={Math.round(W * 0.012)} max={Math.round(W * 0.2)} value={cur.size} onChange={(v) => setLayers((ls) => ls.map((x) => x.id === cur.id ? { ...x, size: v } as L : x))} onChangeComplete={(v) => patch(cur.id, { size: v })} /></div>
        <div className="dz-row"><span>粗细</span><Segmented size="small" block value={cur.weight} onChange={(v) => patch(cur.id, { weight: v as TextL['weight'] })} options={[{ value: 400, label: '常规' }, { value: 700, label: '粗' }, { value: 900, label: '特粗' }]} /></div>
        <div className="dz-row"><span>对齐</span><Segmented size="small" block value={cur.align} onChange={(v) => patch(cur.id, { align: v as TextL['align'] })} options={[{ value: 'left', label: '左' }, { value: 'center', label: '中' }, { value: 'right', label: '右' }]} /></div>
        <div className="dz-row"><span>颜色</span><Swatches value={cur.color} brand={brandColor} onChange={(c) => c && patch(cur.id, { color: c })} /></div>
        <div className="dz-row"><span>描边</span>
          <Swatches value={cur.stroke} brand={brandColor} allowNone onChange={(c) => patch(cur.id, { stroke: c, strokeW: c ? (cur.strokeW || Math.max(2, Math.round(cur.size * 0.08))) : 0 })} />
        </div>
        <div className="dz-row"><span>字距</span><Slider min={-10} max={60} value={cur.spacing} onChangeComplete={(v) => patch(cur.id, { spacing: v })} onChange={(v) => setLayers((ls) => ls.map((x) => x.id === cur.id ? { ...x, spacing: v } as L : x))} /></div>
        <div className="dz-row"><span>投影</span><Segmented size="small" block value={cur.shadow ? 1 : 0} onChange={(v) => patch(cur.id, { shadow: !!v })} options={[{ value: 0, label: '无' }, { value: 1, label: '有' }]} /></div>
      </>)}
      {cur.type === 'rect' && (<>
        <div className="dz-row"><span>颜色</span><Swatches value={cur.fill} brand={brandColor} onChange={(c) => c && patch(cur.id, { fill: c })} /></div>
        <div className="dz-row"><span>圆角</span><Slider min={0} max={Math.round(Math.min(cur.w, cur.h) / 2)} value={cur.radius} onChangeComplete={(v) => patch(cur.id, { radius: v })} onChange={(v) => setLayers((ls) => ls.map((x) => x.id === cur.id ? { ...x, radius: v } as L : x))} /></div>
      </>)}
      {cur.type === 'image' && (
        <div className="dz-row"><span>投影</span><Segmented size="small" block value={cur.shadow ? 1 : 0} onChange={(v) => patch(cur.id, { shadow: !!v })} options={[{ value: 0, label: '无' }, { value: 1, label: '有' }]} /></div>
      )}
      <div className="dz-row"><span>透明</span><Slider min={10} max={100} value={Math.round(cur.opacity * 100)} onChangeComplete={(v) => patch(cur.id, { opacity: v / 100 })} onChange={(v) => setLayers((ls) => ls.map((x) => x.id === cur.id ? { ...x, opacity: v / 100 } as L : x))} /></div>
      <div className="dz-row"><span>旋转</span><InputNumber size="small" min={-180} max={180} value={cur.rot} onChange={(v) => patch(cur.id, { rot: Number(v) || 0 })} suffix="°" style={{ width: 110 }} /></div>
    </div>
  );

  const layerList = (
    <div className="dz-layers">
      <div className="dz-ph"><b>图层</b><small>{layers.length} 个</small></div>
      <ul>
        {[...layers].reverse().map((l) => (
          <li key={l.id} className={l.id === sel ? 'on' : ''} onClick={() => setSel(l.id)}>
            <i>{l.type === 'text' ? <FontSizeOutlined /> : l.type === 'rect' ? <BorderOutlined /> : <PictureOutlined />}</i>
            <span>{l.type === 'text' ? (l.text || '（空）') : l.type === 'rect' ? '色块' : LAYER_NAMES[l.role]}</span>
            <button type="button" aria-label={l.hidden ? '显示' : '隐藏'} onClick={(e) => { e.stopPropagation(); patch(l.id, { hidden: !l.hidden }); }}>{l.hidden ? <EyeInvisibleOutlined /> : <EyeOutlined />}</button>
          </li>
        ))}
        <li className="base"><i><PictureOutlined /></i><span>原图（锁定）</span></li>
      </ul>
    </div>
  );

  return (
    <Modal open={open} onCancel={onClose} title="图层编辑" width={mobile ? '100%' : 1180} centered destroyOnHidden className="dz-modal"
      footer={[
        <span key="tip" className="dz-tip">拖动摆放 · 拖角缩放 · 方向键微调 · ⌘/Ctrl+Z 撤销</span>,
        <Button key="c" onClick={onClose}>取消</Button>,
        <Button key="s" type="primary" loading={busy} onClick={save} disabled={!data}>保存为新版本 · 免费</Button>,
      ]}>
      {!data ? <div className="dz-load"><Spin /></div> : (
        <div className="dz">
          <div className="dz-tools">
            <Popover content={textMenu} trigger="click" placement="rightTop" open={menu === 'text'} onOpenChange={(o) => setMenu(o ? 'text' : null)}><button type="button"><FontSizeOutlined /><small>文字</small></button></Popover>
            <button type="button" onClick={addRect}><BgColorsOutlined /><small>色块</small></button>
            {data.matting && <Popover content={productMenu} trigger="click" placement="rightTop" open={menu === 'prod'} onOpenChange={(o) => setMenu(o ? 'prod' : null)}><button type="button" disabled={cutting}>{cutting ? <Spin size="small" /> : <ScissorOutlined />}<small>商品</small></button></Popover>}
            <button type="button" onClick={() => fileRef.current?.click()}><AppstoreAddOutlined /><small>Logo/图</small></button>
            <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadImage(f); e.target.value = ''; }} />
            <i className="sep" />
            <button type="button" onClick={undo} disabled={!past.length}><UndoOutlined /><small>撤销</small></button>
            <button type="button" onClick={redo} disabled={!future.length}><RedoOutlined /><small>重做</small></button>
          </div>
          <div className="dz-canvas" ref={boxRef}>
            {scale > 0 && (
              <Stage ref={stageRef} width={W * scale} height={H * scale} scaleX={scale} scaleY={scale}
                onMouseDown={(e) => { if (e.target === e.target.getStage() || e.target.id() === 'base') setSel(null); }}
                onTouchStart={(e) => { if (e.target === e.target.getStage() || e.target.id() === 'base') setSel(null); }}>
                <KLayer>
                  {baseImg && <KImage id="base" image={baseImg} width={W} height={H} />}
                  {layers.map(render)}
                  {guides.v && <Line points={[W / 2, 0, W / 2, H]} stroke="#e0457b" strokeWidth={1 / scale} dash={[6 / scale, 4 / scale]} listening={false} />}
                  {guides.h && <Line points={[0, H / 2, W, H / 2]} stroke="#e0457b" strokeWidth={1 / scale} dash={[6 / scale, 4 / scale]} listening={false} />}
                  <Transformer ref={trRef} rotateEnabled keepRatio={cur?.type !== 'rect'} borderStroke="#b5492f" anchorStroke="#b5492f" anchorFill="#fff" anchorSize={9} anchorCornerRadius={2}
                    enabledAnchors={cur?.type === 'text' ? ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'middle-left', 'middle-right'] : undefined}
                    boundBoxFunc={(o, n) => (n.width < 8 || n.height < 8 ? o : n)} />
                </KLayer>
              </Stage>
            )}
          </div>
          <div className="dz-side">
            {props ?? <p className="dz-hint">点画布上的元素来修改；用工具栏添加文字、色块、商品图层或 Logo。</p>}
            {layerList}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Swatches({ value, onChange, brand, allowNone }: { value: string | null; onChange: (c: string | null) => void; brand?: string | null; allowNone?: boolean }) {
  const list = [...new Set([...(brand ? [brand.toLowerCase()] : []), ...SWATCHES])].slice(0, 7);
  return (
    <div className="dz-sw">
      {allowNone && <button type="button" className={`none${!value ? ' on' : ''}`} onClick={() => onChange(null)} aria-label="无" />}
      {list.map((c) => <button key={c} type="button" className={value?.toLowerCase() === c.toLowerCase() ? 'on' : ''} style={{ background: c }} onClick={() => onChange(c)} aria-label={c} />)}
      <ColorPicker size="small" value={value ?? '#000000'} disabledAlpha onChangeComplete={(c) => onChange(c.toHexString())} />
    </div>
  );
}
