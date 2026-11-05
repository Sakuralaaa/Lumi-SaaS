import { useState, type CSSProperties } from 'react';
import { App, Image, Tooltip } from 'antd';
import { ClockCircleOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, ExclamationCircleOutlined, EyeOutlined, FontSizeOutlined, HeartFilled, HeartOutlined, RedoOutlined } from '@ant-design/icons';
import { api, safeUrl } from '../api/client';
import type { Item } from '../api/types';
import { expiryText, ratioAspect } from '../lib/labels';
import { useErrorToast } from '../lib/notify';

interface Props {
  item: Item;
  label?: string;
  onChange: (patch: Partial<Item>) => void;
  onDeleted: () => void;
  fixedAspect?: boolean;
  onRetry?: () => void;
  onEdit?: () => void;
  /** open the big viewer instead of the plain preview */
  onOpen?: () => void;
  onText?: () => void;
  /** number of versions of this image (original + edits) */
  versions?: number;
  /** a newer version is being generated */
  pending?: boolean;
}

export async function downloadItem(id: string) {
  const r = await api.get<{ url: string }>(`/api/items/${id}/download`);
  const u = safeUrl(r.url);
  if (!u) return;
  const a = document.createElement('a');
  a.href = u;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export default function ItemCard({ item, label, onChange, onDeleted, onRetry, onEdit, onOpen, onText, versions, pending }: Props) {
  const [preview, setPreview] = useState(false);
  const { modal } = App.useApp();
  const toast = useErrorToast();
  const aspect = ratioAspect(item.ratio);
  const [aw, ah] = aspect.split('/').map(Number);
  const cs = { aspectRatio: aspect, '--ar': aw / ah } as CSSProperties;
  const tagText = label ?? item.ratio;

  if (item.status === 'queued' || item.status === 'running') {
    return (
      <div className="cell wait shimmer" style={cs}>
        <span className="tag">{tagText}</span>
        <div className="spin" />
        <span>{item.status === 'running' ? '生成中' : '排队中'}</span>
      </div>
    );
  }

  const vbadge = (versions ?? 1) > 1 || pending ? <span className={`ver${pending ? ' run' : ''}`}>{pending ? '修改中…' : `${versions} 个版本`}</span> : null;
  const remove = () => {
    modal.confirm({
      title: '删除这张图？',
      content: '删除后无法恢复。',
      okText: '删除', okButtonProps: { danger: true }, cancelText: '取消',
      onOk: async () => {
        try { await api.del(`/api/items/${item.id}`); onDeleted(); } catch (e) { toast(e); }
      },
    });
  };

  if (item.status === 'failed') {
    return (
      <div className="cell failed" style={cs}>
        <span className="tag">{tagText}</span>
        <ExclamationCircleOutlined />
        <span>{item.error || '生成失败，积分已退回'}</span>
        {onRetry && <button type="button" className="retry-btn" onClick={onRetry}><RedoOutlined />重试这张</button>}
        {vbadge}
      </div>
    );
  }

  if (item.expired) {
    return (
      <div className="cell failed expired" style={cs}>
        <span className="tag">{tagText}</span>
        <ClockCircleOutlined />
        <span>已过期</span>
        <small>超过保存期限，文件已删除</small>
        <Tooltip title="从列表移除">
          <button className="del-x" onClick={remove} aria-label="删除"><DeleteOutlined /></button>
        </Tooltip>
      </div>
    );
  }

  const expiring = expiryText(item.expiresAt);
  const thumb = safeUrl(item.thumb) ?? safeUrl(item.url);
  const full = safeUrl(item.url) ?? thumb;

  const toggleFav = async () => {
    const next = !item.favorite;
    onChange({ favorite: next });
    try { await api.post(`/api/items/${item.id}/favorite`, { favorite: next }); } catch (e) { onChange({ favorite: !next }); toast(e); }
  };

  const download = async () => { try { await downloadItem(item.id); } catch (e) { toast(e); } };

  return (
    <div className="cell" style={cs}>
      <Image
        src={thumb}
        alt=""
        preview={onOpen ? false : { visible: preview, src: full, onVisibleChange: (v) => setPreview(v), mask: false }}
        onClick={() => (onOpen ? onOpen() : setPreview(true))}
        fallback="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"
      />
      <span className="tag">{tagText}</span>
      {vbadge}
      {expiring && <Tooltip title="超过保存期限后文件会被删除，请及时下载"><span className="exp">{expiring}</span></Tooltip>}
      {item.favorite && <button className="fav" onClick={toggleFav} aria-label="取消收藏"><HeartFilled /></button>}
      <div className="tools">
        <Tooltip title="大图 · 版本对比"><button onClick={() => (onOpen ? onOpen() : setPreview(true))} aria-label="大图预览"><EyeOutlined /></button></Tooltip>
        <Tooltip title={item.favorite ? '取消收藏' : '收藏'}>
          <button onClick={toggleFav} aria-label="收藏">{item.favorite ? <HeartFilled style={{ color: '#d4543b' }} /> : <HeartOutlined />}</button>
        </Tooltip>
        {onRetry && <Tooltip title="重试这张"><button onClick={onRetry} aria-label="重试这张"><RedoOutlined /></button></Tooltip>}
        {onText && <Tooltip title="加文字 / Logo / 商品图层（免费）"><button onClick={onText} aria-label="编辑图层"><FontSizeOutlined /></button></Tooltip>}
        {onEdit && <Tooltip title="修改：一句话改、消除、扩图、换白底、换色、翻译"><button className="lbl-btn" onClick={onEdit} aria-label="修改"><EditOutlined /><span className="lbl">修改</span></button></Tooltip>}
        <Tooltip title="删除"><button className="danger" onClick={remove} aria-label="删除"><DeleteOutlined /></button></Tooltip>
        <Tooltip title="下载"><button className="lbl-btn" onClick={download} aria-label="下载"><DownloadOutlined /><span className="lbl">下载</span></button></Tooltip>
      </div>
    </div>
  );
}
