import { useState } from 'react';
import { Button, Dropdown, Input, Modal, Select } from 'antd';
import { BlockOutlined } from '@ant-design/icons';
import type { EditOp, Quality } from '../api/types';
import { LANGS } from '../lib/labels';
import { useOptions } from '../lib/projects';

const OPS: { key: EditOp; label: string; tip: string }[] = [
  { key: 'translate', label: '整套翻译文字', tip: '把这一批图上的标题和卖点翻译成另一种语言，排版不变' },
  { key: 'recolor', label: '整套换色', tip: '这一批里的商品统一换成新颜色，比如出一套新色款' },
  { key: 'cutout', label: '整套换白底', tip: '每张都把商品放到纯白背景上' },
  { key: 'upscale', label: '整套高清重绘', tip: '按高清画质重绘，内容不变' },
];

export interface BatchEditRequest { op: EditOp; text: string; lang?: string }

/** Applies one edit to every image of a batch (each result becomes a new version of its image). */
export default function BatchEdit({ count, quality, onSubmit }: { count: number; quality: Quality; onSubmit: (r: BatchEditRequest) => Promise<boolean> }) {
  const opts = useOptions();
  const [op, setOp] = useState<EditOp | null>(null);
  const [text, setText] = useState('');
  const [lang, setLang] = useState('en');
  const [busy, setBusy] = useState(false);
  const q: Quality = op === 'upscale' ? 'hd' : quality;
  const cost = (opts.prices[q] ?? 0) * count;
  const blocker = op === 'recolor' && text.trim().length < 2 ? '写一下要换成什么颜色' : null;
  const go = async () => {
    if (!op || blocker) return;
    setBusy(true);
    try { if (await onSubmit({ op, text: text.trim(), ...(op === 'translate' ? { lang } : {}) })) setOp(null); } finally { setBusy(false); }
  };
  const cur = OPS.find((o) => o.key === op);
  return (
    <>
      <Dropdown trigger={['click']} disabled={!count} menu={{ items: OPS.map((o) => ({ key: o.key, label: o.label })), onClick: ({ key }) => { setOp(key as EditOp); setText(''); } }}>
        <Button size="small" icon={<BlockOutlined />}>整套修改</Button>
      </Dropdown>
      <Modal open={!!op} onCancel={() => setOp(null)} title={cur?.label} width={440} centered destroyOnHidden
        okText={`改 ${count} 张 · ${cost} 积分`} cancelText="取消" onOk={go} confirmLoading={busy} okButtonProps={{ disabled: !!blocker }}>
        <p className="muted-p">{cur?.tip}。改好的图会作为每张图的新版本，原图保留。</p>
        {op === 'translate' && <Select value={lang} onChange={setLang} options={LANGS.filter((l) => l.value !== 'zh')} style={{ width: '100%' }} />}
        {op === 'recolor' && <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={100} placeholder="比如：主体换成奶油白，金属件不变" />}
      </Modal>
    </>
  );
}
