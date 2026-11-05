import { useEffect, useRef, useState } from 'react';
import { App, Input, Modal, Segmented, Select, Slider } from 'antd';
import { api, safeUrl } from '../api/client';
import type { EditOp, Item, Portrait, Quality, Upload } from '../api/types';
import { LANGS, RATIO_OPTIONS, ratioAspect } from '../lib/labels';
import { useModelLibrary } from '../lib/models';
import ModelSelect from './models/ModelSelect';
import { useOptions } from '../lib/projects';
import { useErrorToast } from '../lib/notify';

const OPS: { value: EditOp; label: string; tip: string }[] = [
  { value: 'free', label: '一句话改', tip: '说一句想怎么改，其它地方保持不变' },
  { value: 'erase', label: '消除', tip: '涂抹要去掉的东西，会自然补全背景' },
  { value: 'expand', label: '扩图', tip: '换一个比例，向外补全画面' },
  { value: 'cutout', label: '抠图', tip: '商品原样抠出来，放到纯白背景或做成透明底 PNG（商品像素不重画）' },
  { value: 'upscale', label: '高清重绘', tip: '按高清画质重绘一遍，内容不变' },
  { value: 'recolor', label: '换色', tip: '比如：杯身换成雾霾蓝，盖子不变' },
  { value: 'translate', label: '翻译文字', tip: '把图上加的标题和卖点翻译成别的语言，排版不变（商品包装上的字不动）' },
  { value: 'swap_model', label: '换模特', tip: '衣服、姿势、背景都不变，只把人换成模特库里的另一位' },
  { value: 'pose', label: '换姿势', tip: '同一个人、同一身衣服，换一个姿势和角度' },
];

export interface EditRequest { op: EditOp; text: string; ratio?: string; baseAssetId?: string; lang?: string; modelAssetId?: string }

export default function EditModal({ item, quality, open, onClose, onSubmit, title = '修改这张图', initialOp = 'free' }: {
  item: Item | null; quality: Quality; open: boolean; onClose: () => void; onSubmit: (r: EditRequest) => Promise<boolean>; title?: string; initialOp?: EditOp;
}) {
  const opts = useOptions();
  const toast = useErrorToast();
  const { message } = App.useApp();
  const [op, setOp] = useState<EditOp>('free');
  const [text, setText] = useState('');
  const [ratio, setRatio] = useState<string | undefined>();
  const [brush, setBrush] = useState(36);
  const [busy, setBusy] = useState(false);
  const [painted, setPainted] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [lang, setLang] = useState('en');
  const [pm, setPm] = useState<Portrait | null>(null);
  const lib = useModelLibrary(open && op === 'swap_model');
  const [libSrc, setLibSrc] = useState<'ai' | 'upload'>('ai');
  const [bg, setBg] = useState<'white' | 'clear'>('white');

  useEffect(() => { if (open) { setOp(initialOp === 'matte' ? 'cutout' : initialOp); setBg(initialOp === 'matte' ? 'clear' : 'white'); setText(''); setRatio(undefined); setPainted(false); setPm(null); } }, [open, item?.id, initialOp]);

  const src = safeUrl(item?.url) ?? safeUrl(item?.thumb);
  const fitCanvas = () => {
    const im = imgRef.current; const c = canvas.current;
    if (!im || !c || !im.naturalWidth) return;
    if (c.width !== im.naturalWidth) { c.width = im.naturalWidth; c.height = im.naturalHeight; setPainted(false); }
  };
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current!; const r = c.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height, k: c.width / r.width };
  };
  const stroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current; if (!c) return;
    const ctx = c.getContext('2d')!; const p = pos(e);
    ctx.strokeStyle = '#ff2020'; ctx.fillStyle = '#ff2020'; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = brush * p.k;
    ctx.beginPath();
    if (last.current) { ctx.moveTo(last.current.x, last.current.y); ctx.lineTo(p.x, p.y); ctx.stroke(); }
    else { ctx.arc(p.x, p.y, (brush * p.k) / 2, 0, Math.PI * 2); ctx.fill(); }
    last.current = { x: p.x, y: p.y };
    setPainted(true);
  };
  const clear = () => { const c = canvas.current; if (c) c.getContext('2d')!.clearRect(0, 0, c.width, c.height); setPainted(false); };

  /** The photo with translucent red strokes baked in, uploaded as the edit's base image. */
  const markedUpload = async (): Promise<Upload> => {
    const im = imgRef.current!; const c = canvas.current!;
    const out = document.createElement('canvas'); out.width = im.naturalWidth; out.height = im.naturalHeight;
    const ctx = out.getContext('2d')!;
    ctx.drawImage(im, 0, 0); ctx.globalAlpha = 0.6; ctx.drawImage(c, 0, 0);
    const blob: Blob = await new Promise((res, rej) => out.toBlob((b) => (b ? res(b) : rej(new Error('无法处理图片'))), 'image/jpeg', 0.92));
    return api.upload<Upload>('/api/uploads', new File([blob], 'marked.jpg', { type: 'image/jpeg' }));
  };

  const needsText = op === 'free' || op === 'recolor';
  const q: Quality = op === 'upscale' ? 'hd' : quality;
  const cost = opts.prices[q] ?? 0;
  let blocker: string | null = null;
  if (needsText && text.trim().length < 2) blocker = op === 'recolor' ? '写一下要换成什么颜色' : '写一句想怎么改';
  if (op === 'erase' && !painted) blocker = '在图上涂抹要消除的地方';
  if (op === 'expand' && !ratio) blocker = '选一个新比例';
  if (op === 'swap_model' && !pm) blocker = '选一位要换上的模特';

  const go = async () => {
    if (blocker || !item) return;
    setBusy(true);
    try {
      const req: EditRequest = { op: op === 'cutout' && bg === 'clear' ? 'matte' : op, text: text.trim() };
      if (op === 'expand') req.ratio = ratio;
      if (op === 'translate') req.lang = lang;
      if (op === 'swap_model' && pm) req.modelAssetId = pm.portraitAssetId;
      if (op === 'erase') req.baseAssetId = (await markedUpload()).id;
      if (await onSubmit(req)) onClose();
    } catch (e) {
      if (e instanceof DOMException) message.error('这张图暂时无法涂抹，请刷新页面后再试'); else toast(e);
    } finally { setBusy(false); }
  };

  const tip = OPS.find((o) => o.value === op)?.tip;
  return (
    <Modal open={open} onCancel={onClose} title={title} width={800} destroyOnHidden centered
      okText={`生成 · ${cost} 积分`} cancelText="取消" onOk={go} confirmLoading={busy} okButtonProps={{ disabled: !!blocker }}>
      <div className="edit-dlg">
        <div className="edit-stage" style={{ aspectRatio: ratioAspect(item?.ratio ?? '1:1') }}>
          {src && <img ref={imgRef} src={src} alt="" crossOrigin="use-credentials" onLoad={fitCanvas} />}
          {op === 'erase' && (
            <canvas ref={canvas} className="edit-mask"
              onPointerDown={(e) => { fitCanvas(); drawing.current = true; last.current = null; (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId); stroke(e); }}
              onPointerMove={(e) => drawing.current && stroke(e)}
              onPointerUp={() => { drawing.current = false; last.current = null; }}
              onPointerCancel={() => { drawing.current = false; last.current = null; }} />
          )}
        </div>
        <div className="edit-side">
          <div className="edit-ops-grid" role="radiogroup" aria-label="修改方式">
            {OPS.map((o) => (
              <button key={o.value} type="button" role="radio" aria-checked={op === o.value} className={op === o.value ? 'on' : ''} onClick={() => { setOp(o.value); setPainted(false); }}>{o.label}</button>
            ))}
          </div>
          <p className="edit-tip">{tip}</p>
          {op === 'erase' && (
            <div className="edit-brush">
              <span>画笔</span><Slider min={12} max={90} value={brush} onChange={setBrush} />
              <button type="button" className="lnk" onClick={clear} disabled={!painted}>清除</button>
            </div>
          )}
          {op === 'expand' && (
            <div className="pills edit-ratios">
              {RATIO_OPTIONS.filter((r) => r.value !== item?.ratio && opts.ratios.includes(r.value)).map((r) => (
                <button key={r.value} type="button" className={`pill${ratio === r.value ? ' on' : ''}`} onClick={() => setRatio(r.value)}>
                  <span className="top">{r.value}</span><small>{r.label || ' '}</small>
                </button>
              ))}
            </div>
          )}
          {op === 'cutout' && (
            <div className="edit-row"><span>背景</span>
              <Segmented value={bg} onChange={(v) => setBg(v as 'white' | 'clear')} options={[{ value: 'white', label: '纯白底' }, { value: 'clear', label: '透明底 PNG' }]} />
            </div>
          )}
          {op === 'translate' && (
            <div className="edit-row"><span>翻译成</span>
              <Select value={lang} onChange={setLang} options={LANGS.filter((l) => l.value !== 'zh')} style={{ width: 160 }} />
            </div>
          )}
          {op === 'swap_model' && (
            <div className="edit-models">
              <Segmented size="small" value={libSrc} onChange={(v) => setLibSrc(v as 'ai' | 'upload')} options={[{ value: 'ai', label: 'AI 模特' }, { value: 'upload', label: '我的模特' }]} />
              <ModelSelect source={libSrc} list={lib.list} loading={lib.loading} value={pm?.portraitAssetId ?? null} onChange={setPm} onNew={() => window.open('/models', '_blank')} />
            </div>
          )}
          {(needsText || op === 'erase' || op === 'expand' || op === 'pose' || op === 'swap_model') && (
            <Input.TextArea value={text} onChange={(e) => setText(e.target.value)} maxLength={200} autoSize={{ minRows: 3, maxRows: 5 }}
              placeholder={op === 'free' ? '比如：背景换成浅蓝色，其它不变' : op === 'recolor' ? '比如：杯身换成雾霾蓝，盖子保持原色' : op === 'erase' ? '选填：比如去掉左下角的杂物' : op === 'pose' ? '选填：比如双手插兜，侧身回头' : op === 'swap_model' ? '选填：其它要求' : '选填：新补出来的区域放什么'} />
          )}
          <small className="edit-note">{blocker ?? '改好的图会作为这张图的新版本，原图保留，可以对比。'}</small>
        </div>
      </div>
    </Modal>
  );
}
