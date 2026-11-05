import { useEffect, useState } from 'react';
import { Modal, Tooltip } from 'antd';
import { CheckCircleOutlined, DeleteOutlined, DownloadOutlined, EditOutlined, FontSizeOutlined, HeartFilled, HeartOutlined, LeftOutlined, RedoOutlined, RightOutlined, SwapOutlined, WarningOutlined } from '@ant-design/icons';
import { safeUrl } from '../api/client';
import type { Item, Job } from '../api/types';
import { EDIT_OP_LABELS, QC_LABELS, TAG_LABELS, ratioAspect } from '../lib/labels';

export interface Version { item: Item; job: Job }
/** One image on the board: the original and every retry / edit made from it, oldest first. */
export interface Card { key: string; job: Job; versions: Version[] }

export function versionLabel(v: Version, i: number): string {
  if (i === 0) return '原图';
  if (v.job.kind === 'retry') return '重试';
  return EDIT_OP_LABELS[v.job.editOp ?? 'free'] ?? '修改';
}
/** The version a card shows: the newest finished one (else the newest at all). */
export function shownIndex(c: Card): number {
  for (let i = c.versions.length - 1; i >= 0; i--) if (c.versions[i].item.status === 'succeeded' && !c.versions[i].item.expired) return i;
  return c.versions.length - 1;
}
export function cardType(c: Card): string {
  const root = c.versions[0];
  const tag = root.job.shots?.[root.item.idx ?? -1]?.tag;
  if (tag) return TAG_LABELS[tag] ?? tag;
  if (root.job.template) return '做同款';
  if (root.job.kind === 'edit') return EDIT_OP_LABELS[root.job.editOp ?? 'free'] ?? '修改';
  return '';
}

export default function Viewer({ cards, index, onIndex, onClose, actions }: {
  cards: Card[]; index: number; onIndex: (i: number) => void; onClose: () => void;
  actions: {
    download: (it: Item) => void; edit: (it: Item, j: Job) => void; text: (it: Item, j: Job) => void; retry: (it: Item) => void;
    favorite: (it: Item, j: Job) => void; remove: (it: Item, j: Job) => void;
  };
}) {
  const card = cards[index];
  const [vi, setVi] = useState(0);
  const [compare, setCompare] = useState(false);
  const [split, setSplit] = useState(50);
  useEffect(() => { if (card) { setVi(shownIndex(card)); setCompare(false); setSplit(50); } }, [card?.key, card?.versions.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' && index > 0) onIndex(index - 1);
      if (e.key === 'ArrowRight' && index < cards.length - 1) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, cards.length, onIndex]);
  if (!card) return null;
  const v = card.versions[Math.min(vi, card.versions.length - 1)];
  const it = v.item;
  const prev = vi > 0 ? card.versions.slice(0, vi).reverse().find((x) => x.item.status === 'succeeded' && !x.item.expired) : undefined;
  const src = safeUrl(it.url) ?? safeUrl(it.thumb);
  const before = prev ? safeUrl(prev.item.url) ?? safeUrl(prev.item.thumb) : undefined;
  const ok = it.status === 'succeeded' && !it.expired;
  const qc = it.qc;
  const type = cardType(card);
  const canRetry = (it.status === 'succeeded' || it.status === 'failed') && v.job.kind !== 'edit';

  return (
    <Modal open onCancel={onClose} footer={null} width="min(1180px, 96vw)" centered className="viewer-modal" destroyOnHidden title={null}>
      <div className="viewer">
        <div className="vw-stage">
          <button type="button" className="vw-nav l" disabled={index <= 0} onClick={() => onIndex(index - 1)} aria-label="上一张"><LeftOutlined /></button>
          <div className="vw-img" style={{ aspectRatio: ratioAspect(it.ratio) }}>
            {ok && src ? (
              compare && before ? (
                <div className="cmp">
                  <img src={src} alt="修改后" />
                  <img src={before} alt="修改前" className="cmp-before" style={{ clipPath: `inset(0 ${100 - split}% 0 0)` }} />
                  <i className="cmp-line" style={{ left: `${split}%` }} />
                  <span className="cmp-tag l">修改前</span><span className="cmp-tag r">修改后</span>
                  <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} aria-label="对比" />
                </div>
              ) : <img src={src} alt="" />
            ) : (
              <div className="vw-ph">{it.status === 'failed' ? (it.error || '生成失败，积分已退回') : it.expired ? '已过期' : it.status === 'running' ? '生成中…' : '排队中…'}</div>
            )}
          </div>
          <button type="button" className="vw-nav r" disabled={index >= cards.length - 1} onClick={() => onIndex(index + 1)} aria-label="下一张"><RightOutlined /></button>
        </div>
        <aside className="vw-side">
          <div className="vw-hd">
            <b>{type || '图片'}</b>
            <small>{it.ratio} · {it.quality === 'hd' ? '高清' : '标准'} · {index + 1} / {cards.length}</small>
          </div>
          {card.versions.length > 1 && (
            <div className="vw-vers">
              <div className="vw-lbl">版本 · {card.versions.length}</div>
              <div className="vw-vlist">
                {card.versions.map((x, i) => {
                  const t = safeUrl(x.item.thumb);
                  return (
                    <button key={x.item.id} type="button" className={i === vi ? 'on' : ''} onClick={() => { setVi(i); setCompare(false); }}>
                      {t && !x.item.expired ? <img src={t} alt="" /> : <span className="ph" />}
                      <small>{versionLabel(x, i)}{x.item.status === 'failed' ? ' · 失败' : x.item.status === 'queued' || x.item.status === 'running' ? ' · 生成中' : ''}</small>
                    </button>
                  );
                })}
              </div>
              {prev && ok && (
                <button type="button" className={`vw-cmp${compare ? ' on' : ''}`} onClick={() => setCompare((c) => !c)}><SwapOutlined />{compare ? '退出对比' : '和上一版对比'}</button>
              )}
            </div>
          )}
          {qc && ok && (
            <div className={`vw-qc${qc.pass ? '' : ' warn'}`}>
              {qc.pass ? <CheckCircleOutlined /> : <WarningOutlined />}
              <span>{qc.pass ? (qc.retried ? '自动质检发现问题，已免费重出一次' : '自动质检通过') : `质检提示：${(qc.issues ?? []).map((x) => QC_LABELS[x] ?? x).join('、') || '可能有瑕疵'}`}</span>
            </div>
          )}
          {vi > 0 && v.job.kind === 'edit' && <p className="vw-edit">{versionLabel(v, vi)}{v.job.editText ? `：${v.job.editText}` : ''}</p>}
          {(() => { const r = card.versions[0]; const t = r.job.shots?.[r.item.idx ?? -1]?.text; return t ? <p className="vw-shot">{t}</p> : null; })()}
          <div className="vw-acts">
            {ok && <button type="button" className="pri" onClick={() => actions.download(it)}><DownloadOutlined />下载</button>}
            {ok && <button type="button" onClick={() => actions.edit(it, v.job)}><EditOutlined />修改</button>}
            {ok && <button type="button" onClick={() => actions.text(it, v.job)}><FontSizeOutlined />{it.layered ? '改图层' : '加文字'}</button>}
            {canRetry && <button type="button" onClick={() => actions.retry(it)}><RedoOutlined />重试</button>}
            {ok && (
              <Tooltip title={it.favorite ? '取消收藏' : '收藏'}>
                <button type="button" className={canRetry ? '' : 'wide'} onClick={() => actions.favorite(it, v.job)}>{it.favorite ? <HeartFilled style={{ color: 'var(--accent, #b5492f)' }} /> : <HeartOutlined />}{it.favorite ? '已收藏' : '收藏'}</button>
              </Tooltip>
            )}
            <button type="button" className="danger" onClick={() => actions.remove(it, v.job)}><DeleteOutlined />删除这一版</button>
          </div>
          <small className="vw-key">← → 切换图片</small>
        </aside>
      </div>
    </Modal>
  );
}
