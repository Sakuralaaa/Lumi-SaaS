/**
 * Lumi Studio wordmark. Full size: italic serif "Lumi" with "STUDIO" set beneath it,
 * letters spread to exactly the word's width. Compact (mobile bar): one line, baseline-aligned.
 */
export default function Brand({ sub, compact }: { sub?: string; compact?: boolean }) {
  return (
    <div className={`brand${compact ? ' compact' : ''}`} aria-label={`Lumi Studio${sub ? ` ${sub}` : ''}`}>
      <span className="brand-mark">
        <span className="brand-l">Lumi</span>
        <span className="brand-s" aria-hidden="true">{'STUDIO'.split('').map((c, i) => <i key={i}>{c}</i>)}</span>
      </span>
      {sub && <span className="brand-sub">{sub}</span>}
    </div>
  );
}
