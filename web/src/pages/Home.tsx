import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Input } from 'antd';
import { ArrowRightOutlined } from '@ant-design/icons';
import { useProjects } from '../lib/projects';
import { useErrorToast } from '../lib/notify';
import UploadSlot from '../components/UploadSlot';
import TemplateGallery from '../components/TemplateGallery';
import type { Mode, Upload } from '../api/types';
import { FEATURES } from '../lib/features';
import type { StartSeed } from './Workbench';


export default function Home() {
  const { create } = useProjects();
  const nav = useNavigate();
  const toast = useErrorToast();
  const [product, setProduct] = useState<Upload | null>(null);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const go = async (key: string, mode: Mode, start: StartSeed, name?: string) => {
    if (busy) return;
    setBusy(key);
    try {
      try { localStorage.setItem('lumi.lastMode', mode); } catch { /* ignore */ }
      const id = await create(mode, name);
      nav(`/p/${id}`, { state: { start } });
    } catch (e) { toast(e); setBusy(null); }
  };

  const startHero = () => {
    const p = prompt.trim().slice(0, 500);
    void go('hero', 'simple', { product, prompt: p }, p ? p.slice(0, 20) : undefined);
  };

  return (
    <div className="page home">
      <section className="hero">
        <div className="hero-kicker">LUMI STUDIO</div>
        <h1><span className="nw">一张商品图，</span><span className="nw"><em>出一整套</em>上架图</span></h1>
        <p className="hero-sub">不用写提示词。上传商品，说一句想要的感觉，剩下的交给我们。</p>
        <div className="hero-box">
          <UploadSlot value={product} onChange={setProduct} badge="商品" emptyTitle="上传商品图" emptyHint="JPG / PNG" className="hero-up" />
          <div className="hero-in">
            <Input.TextArea value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={500} autoSize={{ minRows: 2, maxRows: 4 }}
              placeholder="比如：放在米色石材台面上，清晨暖光，高级感"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startHero(); }} />
            <div className="hero-act">
              <span>{product ? '已上传商品，下一步选类型和尺寸' : '也可以先进去再上传'}</span>
              <button type="button" className="hero-go" onClick={startHero} disabled={!!busy}>
                {busy === 'hero' ? '正在打开…' : '开始创作'}<ArrowRightOutlined />
              </button>
            </div>
          </div>
        </div>
      </section>

      <section className="home-sec">
        <div className="sec-hd"><h2>常用玩法</h2><span>点一下，直接开始</span></div>
        <div className="feats">
          {FEATURES.map((f) => (
            <button key={f.key} type="button" className="feat" disabled={!!busy}
              onClick={() => void go(f.key, f.mode, { tags: [f.tag] }, f.title)}>
              <span className="feat-img">
                <img src={`/home/${f.a}.webp`} alt="" loading="lazy" />
                <img src={`/home/${f.b}.webp`} alt="" loading="lazy" />
                <i className="feat-arrow"><ArrowRightOutlined /></i>
                <em className="feat-tag l">原图</em><em className="feat-tag r">出图</em>
              </span>
              <span className="feat-tx"><b>{f.title}</b><small>{f.desc}</small></span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-sec">
        <div className="sec-hd"><h2>做同款</h2><span>看中哪张，换成你的商品</span></div>
        <TemplateGallery compactHeader />
      </section>
    </div>
  );
}
