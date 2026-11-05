import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { App, Spin } from 'antd';
import { CloseOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import type { Upload } from '../api/types';
import { useErrorToast } from '../lib/notify';

const MAX = 15 * 1024 * 1024;
const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const OK_EXT = /\.(jpe?g|png|webp|heic|heif)$/i;

export function validateFile(f: File): string | null {
  const typeOk = OK_TYPES.includes(f.type) || (!f.type && OK_EXT.test(f.name)) || OK_EXT.test(f.name) && f.type === 'application/octet-stream';
  if (!typeOk) return '只支持 JPG / PNG / WebP / HEIC 图片';
  if (f.size > MAX) return '图片太大了，最大 15MB';
  if (f.size === 0) return '文件是空的';
  return null;
}

interface Props {
  value: Upload | null;
  onChange: (u: Upload | null) => void;
  badge?: string;
  emptyTitle: ReactNode;
  emptyHint?: ReactNode;
  style?: CSSProperties;
  className?: string;
  /** upload endpoint (defaults to the user upload endpoint) */
  endpoint?: string;
  /** how many files one pick / drop may carry (default 1). Extra files beyond it are dropped with a notice. */
  maxFiles?: number;
  /** receives every uploaded file of a multi-pick, in pick order; without it only the first goes to onChange */
  onUploadMany?: (us: Upload[]) => void;
  /** wording for the "too many" notice, e.g. 最多 3 件商品 */
  limitText?: string;
}

export default function UploadSlot({ value, onChange, badge, emptyTitle, emptyHint, style, className, endpoint = '/api/uploads', maxFiles = 1, onUploadMany, limitText }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState(false);
  const { message } = App.useApp();
  const toast = useErrorToast();

  const handle = async (list: FileList | File[] | null | undefined) => {
    const all = Array.from(list ?? []);
    if (!all.length) return;
    const cap = Math.max(1, maxFiles);
    if (all.length > cap) message.info(`${limitText ?? `这里最多再放 ${cap} 张`}，已取前 ${cap} 张`);
    const picked: File[] = [];
    for (const f of all.slice(0, cap)) {
      const err = validateFile(f);
      if (err) message.warning(`${f.name}：${err}`); else picked.push(f);
    }
    if (!picked.length) { if (input.current) input.current.value = ''; return; }
    setBusy(true);
    try {
      // upload in parallel but keep pick order; one failure doesn't sink the rest
      const res = await Promise.allSettled(picked.map((f) => api.upload<Upload>(endpoint, f)));
      const ok = res.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      const failed = res.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      if (failed) toast(failed.reason);
      if (ok.length) {
        if (onUploadMany) onUploadMany(ok); else onChange(ok[0]);
        if (ok.length > 1) message.success(`已上传 ${ok.length} 张`);
      }
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };

  const thumb = safeUrl(value?.thumb);

  if (value && thumb) {
    return (
      <div className={`slot ${className ?? ''}`} style={style}>
        <img src={thumb} alt={badge ?? ''} />
        {badge && <span className="badge">{badge}</span>}
        <button type="button" className="x" aria-label="移除" onClick={() => onChange(null)}><CloseOutlined /></button>
      </div>
    );
  }

  return (
    <div
      className={`slot empty${drag ? ' drag' : ''} ${className ?? ''}`}
      style={style}
      role="button"
      tabIndex={0}
      onClick={() => !busy && input.current?.click()}
      onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !busy) { e.preventDefault(); input.current?.click(); } }}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); void handle(e.dataTransfer.files); }}
    >
      <input ref={input} type="file" hidden multiple={maxFiles > 1} accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        onChange={(e) => void handle(e.target.files)} />
      {busy ? <Spin size="small" /> : (
        <>
          <b>＋</b>
          <span>{emptyTitle}</span>
          {emptyHint && <small>{emptyHint}</small>}
        </>
      )}
    </div>
  );
}
