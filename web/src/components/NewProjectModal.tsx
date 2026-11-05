import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Checkbox, Modal } from 'antd';
import { useProjects } from '../lib/projects';
import { useErrorToast } from '../lib/notify';
import type { Mode } from '../api/types';

const KEY = 'lumi.lastMode';
export function lastMode(): Mode {
  try { return localStorage.getItem(KEY) === 'detailed' ? 'detailed' : 'simple'; } catch { return 'simple'; }
}

export function ModeCards({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="np-cards" role="radiogroup">
      <button type="button" role="radio" aria-checked={value === 'simple'} className={`np-opt${value === 'simple' ? ' on' : ''}`} onClick={() => onChange('simple')}>
        <div className="np-pv one"><img src="/img/product.jpg" alt="" /></div>
        <h4>简约</h4>
        <p>单个商品，主图与场景图</p>
        <em>美妆 · 家居 · 数码 · 食品</em>
      </button>
      <button type="button" role="radio" aria-checked={value === 'detailed'} className={`np-opt${value === 'detailed' ? ' on' : ''}`} onClick={() => onChange('detailed')}>
        <div className="np-pv"><img src="/img/c-top.jpg" alt="" /><img src="/img/c-bottom.jpg" alt="" /><img src="/img/c-model.jpg" alt="" /></div>
        <h4>详细</h4>
        <p>商品搭配，可加模特</p>
        <em>服装 · 鞋包 · 配饰 · 套装组合</em>
      </button>
    </div>
  );
}

export default function NewProjectModal() {
  const { newOpen, closeNew, create } = useProjects();
  const [mode, setMode] = useState<Mode>(lastMode);
  const [remember, setRemember] = useState(true);
  const [loading, setLoading] = useState(false);
  const nav = useNavigate();
  const toast = useErrorToast();

  useEffect(() => { if (newOpen) setMode(lastMode()); }, [newOpen]);

  const start = async () => {
    setLoading(true);
    try {
      if (remember) { try { localStorage.setItem(KEY, mode); } catch { /* ignore */ } }
      const id = await create(mode);
      closeNew();
      nav(`/p/${id}`);
    } catch (e) {
      toast(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={newOpen} onCancel={closeNew} footer={null} width={640} centered destroyOnHidden
      styles={{ content: { padding: 28 } }} closable={false}>
      <div className="np-hd"><h3>新建项目</h3><span>选一种方式开始，之后也能在项目里切换</span></div>
      <ModeCards value={mode} onChange={setMode} />
      <div className="np-ft">
        <Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)}>记住我的选择</Checkbox>
        <Button type="text" onClick={closeNew} style={{ color: 'var(--sub)', height: 40 }}>取消</Button>
        <Button className="btn-ink" onClick={start} loading={loading}>开始创作</Button>
      </div>
    </Modal>
  );
}
