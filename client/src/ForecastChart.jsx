import { useMemo, useRef, useState } from 'react';

// Revenue forecast chart (STORY-007), per the dataviz method:
// one measure => one hue (categorical slot 1 blue); actuals solid 2px,
// forecast dashed same hue, 95% prediction interval as a translucent band
// of the same hue; recessive grid/axis chrome; text wears ink tokens, never
// the series color; crosshair + tooltip hover layer.
const C = {
  series: '#2a78d6',
  band: 'rgba(42, 120, 214, 0.16)',
  grid: '#e1e0d9',
  baseline: '#c3c2b7',
  muted: '#898781',
  inkPrimary: '#0b0b0b',
  inkSecondary: '#52514e',
  surface: '#fcfcfb'
};

const W = 980, H = 300, PAD = { l: 56, r: 16, t: 16, b: 28 };
const fmtMoney = (n) => `$${Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const fmtDay = (d) => new Date(d + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export default function ForecastChart({ history, points }) {
  const wrapRef = useRef(null);
  const [hover, setHover] = useState(null);

  const { all, x, y, ticksY, ticksX, bandPath, histLine, fcLine } = useMemo(() => {
    const all = [
      ...history.map((h) => ({ ...h, kind: 'actual' })),
      ...points.map((p) => ({ ...p, kind: 'forecast' }))
    ];
    const yMax = Math.max(...all.map((d) => d.upper ?? d.revenue)) * 1.08;
    const x = (i) => PAD.l + (i / Math.max(all.length - 1, 1)) * (W - PAD.l - PAD.r);
    const y = (v) => H - PAD.b - (v / yMax) * (H - PAD.t - PAD.b);

    const nTicks = 4;
    const ticksY = Array.from({ length: nTicks + 1 }, (_, i) => (yMax / nTicks) * i);
    const every = Math.max(1, Math.round(all.length / 8));
    const ticksX = all.map((d, i) => ({ d, i })).filter(({ i }) => i % every === 0);

    const iFc0 = history.length;
    const line = (arr, offset) =>
      arr.map((d, j) => `${j === 0 ? 'M' : 'L'}${x(offset + j).toFixed(1)},${y(d.revenue).toFixed(1)}`).join('');
    // Band: forecast upper bound out, lower bound back. Anchor at the last actual.
    const lastActual = history[history.length - 1];
    const bandPts = [{ date: lastActual.date, lower: lastActual.revenue, upper: lastActual.revenue }, ...points];
    const bandPath =
      bandPts.map((p, j) => `${j === 0 ? 'M' : 'L'}${x(iFc0 - 1 + j).toFixed(1)},${y(p.upper).toFixed(1)}`).join('') +
      [...bandPts].reverse().map((p, j) =>
        `L${x(iFc0 - 1 + (bandPts.length - 1 - j)).toFixed(1)},${y(p.lower).toFixed(1)}`).join('') + 'Z';

    return {
      all, x, y, ticksY, ticksX, bandPath,
      histLine: line(history, 0),
      // start the dashed line from the last actual so there is no gap
      fcLine: `M${x(iFc0 - 1).toFixed(1)},${y(lastActual.revenue).toFixed(1)}` +
        points.map((d, j) => `L${x(iFc0 + j).toFixed(1)},${y(d.revenue).toFixed(1)}`).join('')
    };
  }, [history, points]);

  const onMove = (e) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const idx = Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (all.length - 1));
    if (idx >= 0 && idx < all.length) setHover({ idx, d: all[idx] });
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', background: C.surface, borderRadius: 8 }}
      onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', display: 'block' }} role="img"
        aria-label="Daily revenue: actuals and 30-day forecast with 95% interval">
        {ticksY.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)}
              stroke={v === 0 ? C.baseline : C.grid} strokeWidth="1" />
            <text x={PAD.l - 8} y={y(v) + 4} textAnchor="end" fontSize="11" fill={C.muted}>
              {fmtMoney(v)}
            </text>
          </g>
        ))}
        {ticksX.map(({ d, i }) => (
          <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill={C.muted}>
            {fmtDay(d.date)}
          </text>
        ))}
        <path d={bandPath} fill={C.band} stroke="none" />
        <path d={histLine} fill="none" stroke={C.series} strokeWidth="2" />
        <path d={fcLine} fill="none" stroke={C.series} strokeWidth="2" strokeDasharray="5 4" />
        {hover && (
          <>
            <line x1={x(hover.idx)} x2={x(hover.idx)} y1={PAD.t} y2={H - PAD.b}
              stroke={C.baseline} strokeWidth="1" strokeDasharray="2 3" />
            <circle cx={x(hover.idx)} cy={y(hover.d.revenue)} r="4"
              fill={C.series} stroke={C.surface} strokeWidth="2" />
          </>
        )}
      </svg>
      {hover && (
        <div style={{
          position: 'absolute',
          left: `${(x(hover.idx) / W) * 100}%`, top: 6,
          transform: x(hover.idx) > W * 0.7 ? 'translateX(-105%)' : 'translateX(8px)',
          background: '#fff', border: `1px solid ${C.grid}`, borderRadius: 6,
          padding: '6px 10px', fontSize: 12, pointerEvents: 'none',
          boxShadow: '0 1px 4px rgba(11,11,11,0.10)', whiteSpace: 'nowrap'
        }}>
          <div style={{ color: C.inkSecondary }}>{fmtDay(hover.d.date)}
            {hover.d.kind === 'forecast' && ' · forecast'}</div>
          <div style={{ color: C.inkPrimary, fontWeight: 600 }}>{fmtMoney(hover.d.revenue)}</div>
          {hover.d.kind === 'forecast' && (
            <div style={{ color: C.inkSecondary }}>
              95%: {fmtMoney(hover.d.lower)} – {fmtMoney(hover.d.upper)}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 16, padding: '4px 12px 10px', fontSize: 12, color: C.inkSecondary }}>
        <span><svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={C.series} strokeWidth="2" /></svg> Actual</span>
        <span><svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={C.series} strokeWidth="2" strokeDasharray="5 4" /></svg> Forecast</span>
        <span><svg width="18" height="10"><rect width="18" height="10" fill={C.band} /></svg> 95% interval</span>
      </div>
    </div>
  );
}
