/**
 * Grid rasterisation helpers. Coordinates are fractional cells (cell (c, r) centre = (c, r)).
 */

/** Even-odd scanline fill of a set of rings (outer + holes together) with `value`. */
export function fillRings(mask: Uint8Array, nx: number, ny: number, rings: [number, number][][], value: number): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) for (const [, y] of ring) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const r0 = Math.max(0, Math.ceil(minY));
  const r1 = Math.min(ny - 1, Math.floor(maxY));
  const xs: number[] = [];
  for (let r = r0; r <= r1; r++) {
    xs.length = 0;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xa, ya] = ring[j];
        const [xb, yb] = ring[i];
        if (ya <= r !== yb <= r) xs.push(xa + ((r - ya) / (yb - ya)) * (xb - xa));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.ceil(xs[k]));
      const c1 = Math.min(nx - 1, Math.floor(xs[k + 1]));
      for (let c = c0; c <= c1; c++) mask[r * nx + c] = value;
    }
  }
}

/** Thick polyline: every cell whose centre is within `halfWidth` cells of a segment gets `value`. */
export function strokePolyline(mask: Uint8Array, nx: number, ny: number, pts: [number, number][], halfWidth: number, value: number): void {
  const hw = Math.max(0.5, halfWidth);
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    const c0 = Math.max(0, Math.floor(Math.min(ax, bx) - hw));
    const c1 = Math.min(nx - 1, Math.ceil(Math.max(ax, bx) + hw));
    const r0 = Math.max(0, Math.floor(Math.min(ay, by) - hw));
    const r1 = Math.min(ny - 1, Math.ceil(Math.max(ay, by) + hw));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = Math.max(0, Math.min(1, ((c - ax) * dx + (r - ay) * dy) / len2));
        const ex = ax + t * dx - c;
        const ey = ay + t * dy - r;
        if (ex * ex + ey * ey <= hw * hw) mask[r * nx + c] = value;
      }
    }
  }
}

/** Cells of `candidate` (non-zero) connected to the grid border (4-neighbour flood fill). */
export function floodFromEdges(candidate: Uint8Array, nx: number, ny: number): Uint8Array {
  const out = new Uint8Array(nx * ny);
  const stack: number[] = [];
  const push = (i: number) => {
    if (candidate[i] && !out[i]) {
      out[i] = 1;
      stack.push(i);
    }
  };
  for (let c = 0; c < nx; c++) {
    push(c);
    push((ny - 1) * nx + c);
  }
  for (let r = 0; r < ny; r++) {
    push(r * nx);
    push(r * nx + nx - 1);
  }
  while (stack.length) {
    const i = stack.pop()!;
    const c = i % nx;
    if (c > 0) push(i - 1);
    if (c < nx - 1) push(i + 1);
    if (i >= nx) push(i - nx);
    if (i < (ny - 1) * nx) push(i + nx);
  }
  return out;
}

/**
 * 4-connected regions of non-zero cells: `labels[i]` = region index + 1 (0 outside), `sizes[k]` =
 * cell count of region k.
 */
export function labelComponents(mask: Uint8Array, nx: number, ny: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(nx * ny);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const id = sizes.length + 1;
    let size = 0;
    labels[start] = id;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const c = i % nx;
      for (const j of [c > 0 ? i - 1 : -1, c < nx - 1 ? i + 1 : -1, i - nx, i + nx]) {
        if (j >= 0 && j < mask.length && mask[j] && !labels[j]) {
          labels[j] = id;
          stack.push(j);
        }
      }
    }
    sizes.push(size);
  }
  return { labels, sizes };
}

/**
 * Morphological closing (dilate then erode by `radius` cells): bridges gaps up to about 2·radius
 * wide. Use a radius of at least 1.5 so diagonal neighbours count and thin lines survive.
 */
export function closeMask(mask: Uint8Array, nx: number, ny: number, radius: number): Uint8Array {
  const grown = new Uint8Array(mask.length);
  const d = distanceTo(mask, nx, ny);
  for (let i = 0; i < mask.length; i++) grown[i] = d[i] <= radius ? 1 : 0;
  const outside = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) outside[i] = grown[i] ? 0 : 1;
  const back = distanceTo(outside, nx, ny);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = back[i] > radius ? 1 : 0;
  return out;
}

/**
 * Gaussian-like blur (three passes of a separable moving average, half-width `radius` cells).
 * NaN cells are ignored and stay NaN.
 */
export function blurGrid(src: Float32Array, nx: number, ny: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return Float32Array.from(src);
  let a = Float32Array.from(src);
  let b = new Float32Array(src.length);
  const pass = (from: Float32Array, to: Float32Array, n: number, count: number, stride: number, step: number) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let sum = 0;
      let k = 0;
      const at = (t: number) => from[base + t * step];
      for (let t = 0; t <= Math.min(r, n - 1); t++) {
        const v = at(t);
        if (Number.isFinite(v)) {
          sum += v;
          k++;
        }
      }
      for (let t = 0; t < n; t++) {
        const v = at(t);
        to[base + t * step] = Number.isFinite(v) ? (k ? sum / k : v) : NaN;
        const add = t + r + 1;
        if (add < n && Number.isFinite(at(add))) {
          sum += at(add);
          k++;
        }
        const drop = t - r;
        if (drop >= 0 && Number.isFinite(at(drop))) {
          sum -= at(drop);
          k--;
        }
      }
    }
  };
  for (let it = 0; it < 3; it++) {
    pass(a, b, nx, ny, nx, 1); // rows
    [a, b] = [b, a];
    pass(a, b, ny, nx, 1, nx); // columns
    [a, b] = [b, a];
  }
  return a;
}

/**
 * Like `distanceTo`, plus the index of that nearest source cell (−1 when there is none), so a
 * value can be carried from each source to the cells around it.
 */
export function nearestSource(src: Uint8Array, nx: number, ny: number): { dist: Float32Array; idx: Int32Array } {
  const d = new Float32Array(nx * ny);
  const idx = new Int32Array(nx * ny).fill(-1);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) {
    d[i] = src[i] ? 0 : INF;
    if (src[i]) idx[i] = i;
  }
  const D = Math.SQRT2;
  const relax = (i: number, j: number, w: number) => {
    if (d[j] + w < d[i]) {
      d[i] = d[j] + w;
      idx[i] = idx[j];
    }
  };
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      if (c > 0) relax(i, i - 1, 1);
      if (r > 0) {
        relax(i, i - nx, 1);
        if (c > 0) relax(i, i - nx - 1, D);
        if (c < nx - 1) relax(i, i - nx + 1, D);
      }
    }
  }
  for (let r = ny - 1; r >= 0; r--) {
    for (let c = nx - 1; c >= 0; c--) {
      const i = r * nx + c;
      if (c < nx - 1) relax(i, i + 1, 1);
      if (r < ny - 1) {
        relax(i, i + nx, 1);
        if (c < nx - 1) relax(i, i + nx + 1, D);
        if (c > 0) relax(i, i + nx - 1, D);
      }
    }
  }
  return { dist: d, idx };
}

/** Approximate Euclidean distance (cells) to the nearest non-zero cell of `src` (two-pass chamfer). */
export function distanceTo(src: Uint8Array, nx: number, ny: number): Float32Array {
  const d = new Float32Array(nx * ny);
  const INF = 1e9;
  for (let i = 0; i < d.length; i++) d[i] = src[i] ? 0 : INF;
  const D = Math.SQRT2;
  for (let r = 0; r < ny; r++) {
    for (let c = 0; c < nx; c++) {
      const i = r * nx + c;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + 1);
      if (r > 0) {
        v = Math.min(v, d[i - nx] + 1);
        if (c > 0) v = Math.min(v, d[i - nx - 1] + D);
        if (c < nx - 1) v = Math.min(v, d[i - nx + 1] + D);
      }
      d[i] = v;
    }
  }
  for (let r = ny - 1; r >= 0; r--) {
    for (let c = nx - 1; c >= 0; c--) {
      const i = r * nx + c;
      let v = d[i];
      if (c < nx - 1) v = Math.min(v, d[i + 1] + 1);
      if (r < ny - 1) {
        v = Math.min(v, d[i + nx] + 1);
        if (c < nx - 1) v = Math.min(v, d[i + nx + 1] + D);
        if (c > 0) v = Math.min(v, d[i + nx - 1] + D);
      }
      d[i] = v;
    }
  }
  return d;
}

/** Square max filter of half-width `radius` cells (separable, monotonic queue per line: O(n)). */
export function maxFilter(src: Float32Array, nx: number, ny: number, radius: number): Float32Array {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return Float32Array.from(src);
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const q = new Int32Array(Math.max(nx, ny));
  const pass = (from: Float32Array, to: Float32Array, n: number, count: number, stride: number, step: number) => {
    for (let line = 0; line < count; line++) {
      const base = line * stride;
      let head = 0;
      let tail = 0;
      // Window [t − r, t + r]; the queue keeps indices of decreasing values.
      for (let t = 0; t < n + r; t++) {
        if (t < n) {
          const v = from[base + t * step];
          while (tail > head && from[base + q[tail - 1] * step] <= v) tail--;
          q[tail++] = t;
        }
        const centre = t - r;
        if (centre < 0) continue;
        while (q[head] < centre - r) head++;
        to[base + centre * step] = from[base + q[head] * step];
      }
    }
  };
  pass(src, tmp, nx, ny, nx, 1);
  pass(tmp, out, ny, nx, 1, nx);
  return out;
}
