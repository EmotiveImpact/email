/** Small hand-drawn SVG charts. They take the accent from CSS, so they follow the business's look. */

type Point = readonly [number, number];

/** A smooth line through the points (Catmull-Rom as cubic Béziers). */
export function smoothPath(points: Point[]) {
  if (points.length === 0) return '';
  let d = `M${points[0]![0].toFixed(1)},${points[0]![1].toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!;
    const p1 = points[i]!;
    const p2 = points[i + 1]!;
    const p3 = points[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]!.toFixed(1)},${c1[1]!.toFixed(1)} ${c2[0]!.toFixed(1)},${c2[1]!.toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

/** Light smoothing so day-to-day noise does not turn the line into a saw. */
export function soften(values: number[], passes = 1) {
  let v = values;
  for (let p = 0; p < passes; p++) {
    v = v.map((x, i) => (v[Math.max(i - 1, 0)]! + 2 * x + v[Math.min(i + 1, v.length - 1)]!) / 4);
  }
  return v;
}

const W = 640;
const H = 150;
const TOP = 10;

export function AreaChart({ series, compare, label }: { series: number[]; compare?: number[]; label: string }) {
  const max = Math.max(1, ...series, ...(compare ?? [])) * 1.15;
  const toPoints = (values: number[]): Point[] =>
    values.map((v, i) => [values.length === 1 ? W / 2 : (i * W) / (values.length - 1), TOP + (H - TOP) * (1 - v / max)]);
  const line = smoothPath(toPoints(series));
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="mt-2.5 min-h-0 w-full flex-1 overflow-visible">
      <defs>
        <linearGradient id="area-fill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--accent)" stopOpacity="0.22" />
          <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`M0,${H} L${W},${H}`} stroke="var(--rule)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      <path d={`M0,${H / 2} L${W},${H / 2}`} stroke="var(--rule)" strokeWidth="1" strokeDasharray="2 4" vectorEffect="non-scaling-stroke" />
      {series.length > 1 && <path d={`${line} L${W},${H} L0,${H} Z`} fill="url(#area-fill)" />}
      {compare && compare.length > 1 && (
        <path d={smoothPath(toPoints(compare))} fill="none" stroke="var(--faint)" strokeWidth="1.5" strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
      )}
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
