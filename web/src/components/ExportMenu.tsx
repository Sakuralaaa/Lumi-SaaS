import { useState } from 'react';
import { App, Button, Dropdown } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';

const ZIP_PRESETS: { key: string; label: string; hint: string }[] = [
  { key: 'original', label: '原图', hint: '按生成尺寸' },
  { key: 'taobao', label: '淘宝天猫', hint: '800×800 · 750 宽' },
  { key: 'jd', label: '京东', hint: '800×800 · 750 宽' },
  { key: 'pdd', label: '拼多多', hint: '750×750 · 750 宽' },
  { key: 'douyin', label: '抖店', hint: '800×800 · 1080×1920' },
  { key: 'xhs', label: '小红书', hint: '1242×1656' },
  { key: 'amazon', label: '亚马逊', hint: '2000×2000' },
];

async function fetchDownload(url: string, fallbackName: string) {
  const res = await fetch(url, { credentials: 'same-origin', headers: { 'X-Requested-With': 'lumi' }, cache: 'no-store' });
  if (!res.ok) {
    let msg = '下载失败，请稍后再试';
    try { msg = (await res.json()).message || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('content-disposition') ?? '';
  const m = cd.match(/filename\*=UTF-8''([^;]+)/i);
  const name = m ? decodeURIComponent(m[1]) : fallbackName;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

export default function ExportMenu({ jobId, count }: { jobId: string; count: number }) {
  const [busy, setBusy] = useState(false);
  const { message } = App.useApp();
  const run = async (key: string) => {
    setBusy(true);
    const hide = message.loading('正在打包…', 0);
    try {
      if (key === 'long') await fetchDownload(`/api/jobs/${jobId}/long`, `lumi-detail-${jobId.slice(0, 6)}.jpg`);
      else await fetchDownload(`/api/jobs/${jobId}/zip?preset=${key}`, `lumi-${key}-${jobId.slice(0, 6)}.zip`);
    } catch (e) { message.error((e as Error).message); } finally { hide(); setBusy(false); }
  };
  return (
    <Dropdown trigger={['click']} disabled={!count || busy} menu={{
      items: [
        { type: 'group', label: '打包 ZIP · 按平台尺寸', children: ZIP_PRESETS.map((p) => ({ key: p.key, label: <span className="exp-i"><b>{p.label}</b><small>{p.hint}</small></span> })) },
        { type: 'divider' },
        { key: 'long', label: <span className="exp-i"><b>详情长图</b><small>750 宽，从上到下拼接</small></span> },
      ],
      onClick: ({ key }) => void run(key),
    }}>
      <Button size="small" icon={<DownloadOutlined />} loading={busy}>打包下载</Button>
    </Dropdown>
  );
}
