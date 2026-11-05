import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRightOutlined } from '@ant-design/icons';
import Brand from '../components/Brand';
import { api, safeUrl } from '../api/client';
import { FEATURES } from '../lib/features';

interface Shot { title: string; category: string; width: number | null; height: number | null; thumb: string }

const STEPS = [
  { n: '01', t: '上传商品图', d: '手机拍的、白底的都可以，一次最多三件。' },
  { n: '02', t: '选玩法或模板', d: '场景、氛围、模特上身，或者直接挑一张做同款。' },
  { n: '03', t: '一次出一整套', d: '主图、详情、竖屏一起出，挑满意的下载。' },
];

/** Public homepage for signed-out visitors: what Lumi does, real samples, then sign in. */
export default function Landing() {
  const [shots, setShots] = useState<Shot[]>([]);
  useEffect(() => {
    api.get<Shot[]>('/api/public/showcase').then((r) => setShots(r.filter((s) => safeUrl(s.thumb)))).catch(() => setShots([]));
  }, []);
  // Duplicate the row so the CSS marquee loops seamlessly.
  const row = shots.length ? [...shots, ...shots] : [];

  return (
    <div className="landing">
      <header className="ld-top">
        <Brand />
        <nav className="ld-nav">
          <Link to="/login" className="ld-link">登录</Link>
          <Link to="/register" className="ld-btn ghost">开始使用 <ArrowRightOutlined /></Link>
        </nav>
      </header>

      <section className="ld-hero">
        <div className="hero-kicker">AI 电商出图</div>
        <h1><span className="nw">一张商品图，</span><span className="nw"><em>出一整套</em>上架图</span></h1>
        <p>不用写提示词。上传商品，说一句想要的感觉，<br />主图、场景、模特、详情一次出齐，商品外观不走样。</p>
        <div className="ld-cta">
          <Link to="/register" className="ld-btn">开始使用 <ArrowRightOutlined /></Link>
          <Link to="/login" className="ld-link">已有账号，登录</Link>
        </div>
        <div className="ld-note">内测中，凭邀请码注册</div>
      </section>

      <section className="ld-marquee" aria-label="出图样例">
        {row.length > 0 ? (
          <div className="ld-track" style={{ ['--n' as any]: shots.length }}>
            {row.map((s, i) => (
              <figure key={i} className="ld-shot" aria-hidden={i >= shots.length}>
                <img src={safeUrl(s.thumb)} alt={i < shots.length ? s.title : ''} loading="lazy"
                  style={{ aspectRatio: s.width && s.height ? `${s.width} / ${s.height}` : '3 / 4' }} />
                <figcaption><b>{s.title}</b><span>{s.category}</span></figcaption>
              </figure>
            ))}
          </div>
        ) : <div className="ld-track ph">{Array.from({ length: 6 }, (_, i) => <span key={i} className="ld-shot sk" />)}</div>}
      </section>

      <section className="ld-sec">
        <div className="sec-hd"><h2>常用玩法</h2><span>左边是原图，右边是出图</span></div>
        <div className="feats">
          {FEATURES.map((f) => (
            <Link key={f.key} to="/register" className="feat">
              <span className="feat-img">
                <img src={`/home/${f.a}.webp`} alt="" loading="lazy" />
                <img src={`/home/${f.b}.webp`} alt="" loading="lazy" />
                <i className="feat-arrow"><ArrowRightOutlined /></i>
                <em className="feat-tag l">原图</em><em className="feat-tag r">出图</em>
              </span>
              <span className="feat-tx"><b>{f.title}</b><small>{f.desc}</small></span>
            </Link>
          ))}
        </div>
      </section>

      <section className="ld-sec">
        <div className="sec-hd"><h2>三步出图</h2><span>不用学，不用调参数</span></div>
        <div className="ld-steps">
          {STEPS.map((s) => (
            <div key={s.n} className="ld-step"><i>{s.n}</i><b>{s.t}</b><p>{s.d}</p></div>
          ))}
        </div>
      </section>

      <section className="ld-end">
        <h2><span className="nw">把拍好的商品图，</span><span className="nw">变成能直接上架的一整套</span></h2>
        <Link to="/register" className="ld-btn">开始使用 <ArrowRightOutlined /></Link>
      </section>

      <footer className="ld-foot"><Brand compact /><span>© 2026 Lumi Studio</span></footer>
    </div>
  );
}
