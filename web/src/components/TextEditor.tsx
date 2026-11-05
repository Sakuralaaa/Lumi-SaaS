import { useEffect, useRef, useState } from 'react';
import { App, ColorPicker, Input, Modal, Segmented, Slider } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import type { Item, Upload } from '../api/types';
import { useErrorToast } from '../lib/notify';

/** A text layer. x/y = centre as a fraction of the image; size = font size as a fraction of the image width. */
interface Layer { id: number; text: string; x: number; y: number; size: number; color: string; weight: 400 | 700 | 900; font: 'sans' | 'serif'; bg: string | null }
const FAMILY = { sans: '"PingFang SC", "Noto Sans SC", "Microsoft YaHei", "Source Han Sans SC", system-ui, sans-serif', serif: '"Noto Serif SC", "Songti SC", serif' };
const SWATCHES = ['#ffffff', '#111111', '#b5492f', '#c8a24a', '#1f3a5f', '#e7a1b0'];
let lid = 0;
const PAD = 0.42; // background padding, in font-size units

export default function TextEditor({ item, open, onClose, onSaved, brandColor }: {
  item: Item | null; open: boolean; onClose: () => void; onSaved: (r: { id: string; reserved: number }) => void; brandColor?: string | null;
}) {
  const { message } = App.useApp();
  const toast = useErrorToast();
  const [layers, setLayers] = useState<Layer[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [w, setW] = useState(0);
  const imgRef = useRef<HTMLImageElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; dx: number; dy: number } | null>(null);
  const src = safeUrl(item?.url) ?? safeUrl(item?.thumb);

  useEffect(() => {
    if (!open) return;
    const first: Layer = { id: ++lid, text: '你的标题', x: 0.5, y: 0.12, size: 0.07, color: '#111111', weight: 700, font: 'sans', bg: null };
    setLayers([first]); setSel(first.id);
  }, [open, item?.id]);
  useEffect(() => {
    if (!open) return;
    const el = stage.current; if (!el) return;
    const ro = new ResizeObserver(() => setW(imgRef.current?.clientWidth ?? 0));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  const cur = layers.find((l) => l.id === sel) ?? null;
  const patch = (p: Partial<Layer>) => setLayers((ls) => ls.map((l) => (l.id === sel ? { ...l, ...p } : l)));
  const add = (kind: 'title' | 'point') => {
    const n = layers.length;
    const l: Layer = kind === 'title'
      ? { id: ++lid, text: '新标题', x: 0.5, y: Math.min(0.9, 0.12 + n * 0.1), size: 0.07, color: '#111111', weight: 700, font: 'sans', bg: null }
      : { id: ++lid, text: '卖点文字', x: 0.5, y: Math.min(0.92, 0.75 + (n % 3) * 0.07), size: 0.04, color: '#ffffff', weight: 700, font: 'sans', bg: brandColor || '#b5492f' };
    setLayers((ls) => [...ls, l]); setSel(l.id);
  };
  const remove = () => { setLayers((ls) => ls.filter((l) => l.id !== sel)); setSel(null); };

  const onDown = (e: React.PointerEvent, l: Layer) => {
    e.stopPropagation(); setSel(l.id);
    const r = imgRef.current!.getBoundingClientRect();
    drag.current = { id: l.id, dx: (e.clientX - r.left) / r.width - l.x, dy: (e.clientY - r.top) / r.height - l.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d) return;
    const r = imgRef.current!.getBoundingClientRect();
    const x = Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width - d.dx));
    const y = Math.min(0.98, Math.max(0.02, (e.clientY - r.top) / r.height - d.dy));
    setLayers((ls) => ls.map((l) => (l.id === d.id ? { ...l, x, y } : l)));
  };

  /** Draw the layers onto the full-resolution photo exactly as previewed, upload it, and save it as a new version. */
  const save = async () => {
    const im = imgRef.current;
    if (!item || !im?.naturalWidth) return;
    const texts = layers.map((l) => l.text.trim()).filter(Boolean);
    if (!texts.length) { message.info('先加一段文字'); return; }
    setBusy(true);
    try {
      const W = im.naturalWidth; const H = im.naturalHeight;
      const c = document.createElement('canvas'); c.width = W; c.height = H;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(im, 0, 0, W, H);
      for (const l of layers) {
        const t = l.text.trim(); if (!t) continue;
        const fs = l.size * W;
        ctx.font = `${l.weight} ${fs}px ${FAMILY[l.font]}`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const lines = t.split('\n');
        const lh = fs * 1.25;
        const tw = Math.max(...lines.map((s) => ctx.measureText(s).width));
        const th = lh * lines.length;
        const cx = l.x * W; const cy = l.y * H;
        if (l.bg) {
          const p = fs * PAD;
          ctx.fillStyle = l.bg;
          ctx.beginPath(); ctx.roundRect(cx - tw / 2 - p * 1.4, cy - th / 2 - p * 0.7, tw + p * 2.8, th + p * 1.4, fs * 0.35); ctx.fill();
        }
        ctx.fillStyle = l.color;
        lines.forEach((s, i) => ctx.fillText(s, cx, cy - th / 2 + lh * (i + 0.5)));
      }
      const blob: Blob = await new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('无法处理图片'))), 'image/jpeg', 0.95));
      const up = await api.upload<Upload>('/api/uploads', new File([blob], 'text.jpg', { type: 'image/jpeg' }));
      const r = await api.post<{ id: string; reserved: number }>(`/api/items/${item.id}/overlay`, { assetId: up.id, texts });
      onSaved(r);
      message.success('已保存为新版本，原图保留');
      onClose();
    } catch (e) {
      if (e instanceof DOMException) message.error('这张图暂时无法编辑，请刷新页面后再试'); else toast(e);
    } finally { setBusy(false); }
  };

  return (
    <Modal open={open} onCancel={onClose} title="加文字" width={980} centered destroyOnHidden okText="保存为新版本 · 免费" cancelText="取消"
      onOk={save} confirmLoading={busy}>
      <div className="txe">
        <div className="txe-stage" ref={stage} onPointerMove={onMove} onPointerUp={() => { drag.current = null; }} onPointerDown={() => setSel(null)}>
          <div className="txe-img">
            {src && <img ref={imgRef} src={src} alt="" crossOrigin="use-credentials" onLoad={() => setW(imgRef.current?.clientWidth ?? 0)} draggable={false} />}
            {w > 0 && layers.map((l) => {
              const fs = l.size * w;
              return (
                <div key={l.id} className={`txe-l${l.id === sel ? ' on' : ''}`} onPointerDown={(e) => onDown(e, l)}
                  style={{ left: `${l.x * 100}%`, top: `${l.y * 100}%`, fontSize: fs, fontWeight: l.weight, fontFamily: FAMILY[l.font], color: l.color,
                    background: l.bg ?? 'transparent', padding: l.bg ? `${fs * PAD * 0.7}px ${fs * PAD * 1.4}px` : 0, borderRadius: fs * 0.35, lineHeight: 1.25 }}>
                  {l.text || ' '}
                </div>
              );
            })}
          </div>
        </div>
        <div className="txe-side">
          <div className="txe-add">
            <button type="button" onClick={() => add('title')}><PlusOutlined />标题</button>
            <button type="button" onClick={() => add('point')}><PlusOutlined />卖点标签</button>
          </div>
          {cur ? (
            <div className="txe-ctl">
              <Input.TextArea value={cur.text} maxLength={60} autoSize={{ minRows: 2, maxRows: 4 }} onChange={(e) => patch({ text: e.target.value })} placeholder="输入文字，可换行" />
              <label><span>字号</span><Slider min={0.02} max={0.14} step={0.002} value={cur.size} onChange={(v) => patch({ size: v })} tooltip={{ open: false }} /></label>
              <label><span>字体</span>
                <Segmented size="small" value={cur.font} onChange={(v) => patch({ font: v as Layer['font'] })} options={[{ value: 'sans', label: '黑体' }, { value: 'serif', label: '宋体' }]} />
                <Segmented size="small" value={cur.weight} onChange={(v) => patch({ weight: v as Layer['weight'] })} options={[{ value: 400, label: '常规' }, { value: 700, label: '粗' }, { value: 900, label: '特粗' }]} />
              </label>
              <label><span>颜色</span>
                <div className="sw-row">
                  {[...(brandColor ? [brandColor] : []), ...SWATCHES].filter((c, i, a) => a.indexOf(c) === i).map((c) => (
                    <button key={c} type="button" className={`sw${cur.color === c ? ' on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => patch({ color: c })} />
                  ))}
                  <ColorPicker size="small" value={cur.color} disabledAlpha onChangeComplete={(c) => patch({ color: c.toHexString().slice(0, 7) })} />
                </div>
              </label>
              <label><span>底色</span>
                <div className="sw-row">
                  <button type="button" className={`sw none${!cur.bg ? ' on' : ''}`} aria-label="无底色" onClick={() => patch({ bg: null })} />
                  {[...(brandColor ? [brandColor] : []), ...SWATCHES].filter((c, i, a) => a.indexOf(c) === i).map((c) => (
                    <button key={c} type="button" className={`sw${cur.bg === c ? ' on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => patch({ bg: c })} />
                  ))}
                </div>
              </label>
              <button type="button" className="txe-del" onClick={remove}><DeleteOutlined />删除这段</button>
            </div>
          ) : <p className="txe-tip">点图上的文字来编辑，按住可以拖动位置。</p>}
          <small className="txe-note">文字由你自己排版，不消耗积分。不能写网址、联系方式、二维码等引流信息。</small>
        </div>
      </div>
    </Modal>
  );
}
