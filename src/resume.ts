// Imperative resume renderer: PDF.js draws page 1 to an offscreen canvas, the
// visible #stage canvas shows it, and a crumple/toss animation runs on demand.
// Ported from the original static index.html. The only structural addition is
// `resumeState`, which the WebGL glass lens reads each frame.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export type AnimState = 'idle' | 'running' | 'gone';
export interface Fit { x: number; y: number; w: number; h: number; }

// Shared, read by FluidLens each frame.
export const resumeState: {
  stage: HTMLCanvasElement | null;
  fit: Fit | null;
  animState: AnimState;
} = { stage: null, fit: null, animState: 'idle' };

let started = false;

export function initResume(): void {
  if (started) return;
  started = true;

  const PDF_URL = 'assets/ResumeOfficial.pdf';
  const MARGIN = 28;

  const stage = document.getElementById('stage') as HTMLCanvasElement;
  const ctx = stage.getContext('2d')!;
  const btn = document.getElementById('crumpleBtn') as HTMLButtonElement;
  const trashEl = document.getElementById('trash')!;
  const hintEl = document.querySelector('.trash-hint')!;
  const docLayer = document.getElementById('docLayer') as HTMLElement;
  const textLayerDiv = document.getElementById('textLayer')!;

  resumeState.stage = stage;

  let dpr = Math.max(1, window.devicePixelRatio || 1);
  let pdfPage: any = null;     // PDF.js page (page 1)
  let pageBase: any = null;    // unscaled viewport, for aspect + scale math
  let source: HTMLCanvasElement | null = null; // offscreen canvas holding the rendered PDF page
  let mesh: { verts: Vert[] } | null = null;
  let animStart = 0;

  const COLS = 24, ROWS = 30;
  const DUR_CRUMPLE = 1600;            // slower, more deliberate crumple
  const TOSS_START = 1500, TOSS_DUR = 1400;
  const TOTAL = TOSS_START + TOSS_DUR;

  function sizeStage() {
    dpr = Math.max(1, window.devicePixelRatio || 1);
    stage.width = Math.floor(window.innerWidth * dpr);
    stage.height = Math.floor(window.innerHeight * dpr);
    stage.style.width = window.innerWidth + 'px';
    stage.style.height = window.innerHeight + 'px';
  }

  function computeFit() {
    if (!source) return;
    const availW = window.innerWidth - MARGIN * 2;
    const availH = window.innerHeight - MARGIN * 2;
    const ar = source.width / source.height;
    let w = availW, h = w / ar;
    if (h > availH) { h = availH; w = h * ar; }
    resumeState.fit = { x: (window.innerWidth - w) / 2, y: (window.innerHeight - h) / 2, w, h };
  }

  function placeDocLayer() {
    const fit = resumeState.fit;
    if (!fit) return;
    docLayer.style.left = fit.x + 'px';
    docLayer.style.top = fit.y + 'px';
    docLayer.style.width = fit.w + 'px';
    docLayer.style.height = fit.h + 'px';
  }

  function drawStatic() {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    const fit = resumeState.fit;
    if (!source || !fit) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.22)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#fff';
    ctx.fillRect(fit.x, fit.y, fit.w, fit.h);
    ctx.restore();
    ctx.drawImage(source, fit.x, fit.y, fit.w, fit.h);
  }

  // ---- Selectable text layer (built manually for version stability) ----
  const measureCanvas = document.createElement('canvas');
  const measureCtx = measureCanvas.getContext('2d')!;

  async function buildTextLayer() {
    const fit = resumeState.fit;
    if (!pdfPage || !fit) return;
    const scaleCSS = fit.w / pageBase.width;          // CSS px per PDF unit
    const viewport = pdfPage.getViewport({ scale: scaleCSS });
    const tc = await pdfPage.getTextContent();

    textLayerDiv.innerHTML = '';
    const frag = document.createDocumentFragment();

    for (const item of tc.items) {
      const str = item.str;
      if (!str || !str.trim()) continue;
      const style = tc.styles[item.fontName] || {};
      if (style.vertical) continue; // resume is horizontal text

      const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
      const fontHeight = Math.hypot(tx[2], tx[3]);
      if (fontHeight < 1) continue;
      const left = tx[4];
      const top = tx[5] - fontHeight; // approx top from baseline
      const fontFamily = style.fontFamily || 'sans-serif';

      // Horizontal scale so the transparent text matches the glyph width.
      measureCtx.font = `${fontHeight}px ${fontFamily}`;
      const measured = measureCtx.measureText(str).width || 1;
      const targetW = item.width * scaleCSS;
      const scaleX = targetW > 0 ? targetW / measured : 1;

      const span = document.createElement('span');
      span.textContent = str;
      span.style.left = left + 'px';
      span.style.top = top + 'px';
      span.style.fontSize = fontHeight + 'px';
      span.style.fontFamily = fontFamily;
      span.style.transform = `scaleX(${scaleX})`;
      frag.appendChild(span);
    }
    textLayerDiv.appendChild(frag);
  }

  // ---- Crumple mesh: smooth coherent noise -> soft, curved creases ----
  interface Wave { fx: number; fy: number; ph: number; amp: number; }
  interface Vert { u: number; v: number; bx: number; by: number; jx: number; jy: number; h: number; }
  interface Pt { x: number; y: number; }

  function makeWaves(n: number): Wave[] {
    const w: Wave[] = [];
    for (let i = 0; i < n; i++) {
      w.push({
        fx: (Math.random() * 2 + 1.2) * Math.PI * (1 + i * 0.8),
        fy: (Math.random() * 2 + 1.2) * Math.PI * (1 + i * 0.8),
        ph: Math.random() * Math.PI * 2,
        amp: 1 / (i + 1)
      });
    }
    return w;
  }

  // Coherent field in [-1, 1]; neighbouring samples vary smoothly so
  // creases follow curved contours rather than random straight edges.
  function fieldVal(waves: Wave[], x: number, y: number) {
    let v = 0, s = 0;
    for (const w of waves) { v += Math.sin(x * w.fx + y * w.fy + w.ph) * w.amp; s += w.amp; }
    return v / s;
  }

  function buildMesh(): { verts: Vert[] } {
    const hWaves = makeWaves(6);
    const jxWaves = makeWaves(5);
    const jyWaves = makeWaves(5);
    const fit = resumeState.fit!;
    const verts: Vert[] = [];
    for (let r = 0; r <= ROWS; r++) {
      for (let c = 0; c <= COLS; c++) {
        const nx = c / COLS, ny = r / ROWS;
        const u = nx * source!.width;
        const v = ny * source!.height;
        const bx = fit.x + nx * fit.w;
        const by = fit.y + ny * fit.h;
        const edge = (c === 0 || c === COLS || r === 0 || r === ROWS) ? 0.45 : 1;
        verts.push({
          u, v, bx, by,
          jx: fieldVal(jxWaves, nx, ny) * edge,
          jy: fieldVal(jyWaves, nx, ny) * edge,
          h: fieldVal(hWaves, nx, ny)
        });
      }
    }
    return { verts };
  }

  function idx(r: number, c: number) { return r * (COLS + 1) + c; }

  function affineFor(p0: Vert, p1: Vert, p2: Vert, d0: Pt, d1: Pt, d2: Pt) {
    const u0 = p0.u, v0 = p0.v, u1 = p1.u, v1 = p1.v, u2 = p2.u, v2 = p2.v;
    const det = u0 * (v1 - v2) - v0 * (u1 - u2) + (u1 * v2 - u2 * v1);
    if (Math.abs(det) < 1e-6) return null;
    const id = 1 / det;
    const a = (d0.x * (v1 - v2) - v0 * (d1.x - d2.x) + (d1.x * v2 - d2.x * v1)) * id;
    const c = (u0 * (d1.x - d2.x) - d0.x * (u1 - u2) + (u1 * d2.x - u2 * d1.x)) * id;
    const e = (u0 * (v1 * d2.x - v2 * d1.x) - v0 * (u1 * d2.x - u2 * d1.x) + d0.x * (u1 * v2 - u2 * v1)) * id;
    const b = (d0.y * (v1 - v2) - v0 * (d1.y - d2.y) + (d1.y * v2 - d2.y * v1)) * id;
    const d = (u0 * (d1.y - d2.y) - d0.y * (u1 - u2) + (u1 * d2.y - u2 * d1.y)) * id;
    const f = (u0 * (v1 * d2.y - v2 * d1.y) - v0 * (u1 * d2.y - u2 * d1.y) + d0.y * (u1 * v2 - u2 * v1)) * id;
    return [a, b, c, d, e, f] as const;
  }

  function inflate(d0: Pt, d1: Pt, d2: Pt, amt: number): [Pt, Pt, Pt] {
    const cx = (d0.x + d1.x + d2.x) / 3, cy = (d0.y + d1.y + d2.y) / 3;
    const push = (p: Pt): Pt => {
      const dx = p.x - cx, dy = p.y - cy;
      const len = Math.hypot(dx, dy) || 1;
      return { x: p.x + (dx / len) * amt, y: p.y + (dy / len) * amt };
    };
    return [push(d0), push(d1), push(d2)];
  }

  function easeInOut(t: number) { return t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }
  function easeIn(t: number) { return t * t; }
  function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }
  function smoothstep(a: number, b: number, x: number) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

  function drawCrumpled(crumple: number, toss: number) {
    const fit = resumeState.fit!;
    const cx = fit.x + fit.w / 2, cy = fit.y + fit.h / 2;
    const ballScale = lerp(1, 0.15, crumple);
    const dest = mesh!.verts.map(vert => {
      const px = cx + (vert.bx - cx) * ballScale;
      const py = cy + (vert.by - cy) * ballScale;
      const amp = (fit.w / COLS) * 2.4 * crumple;
      return { x: px + vert.jx * amp, y: py + vert.jy * amp };
    });

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    ctx.save();

    if (toss > 0) {
      const tr = trashEl.getBoundingClientRect();
      const target = { x: tr.left + tr.width / 2, y: tr.top + tr.height * 0.35 };
      const start = { x: cx, y: cy };
      const ctrl = { x: (start.x + target.x) / 2, y: Math.min(start.y, target.y) - 180 };
      const p = easeIn(toss), mt = 1 - p;
      const px = mt * mt * start.x + 2 * mt * p * ctrl.x + p * p * target.x;
      const py = mt * mt * start.y + 2 * mt * p * ctrl.y + p * p * target.y;
      ctx.translate(px, py);
      ctx.rotate(p * Math.PI * 5);
      ctx.scale(lerp(1, 0.22, p), lerp(1, 0.22, p));
      ctx.translate(-cx, -cy);
    }

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const a = mesh!.verts[idx(r, c)], b = mesh!.verts[idx(r, c + 1)];
        const cc = mesh!.verts[idx(r + 1, c)], d = mesh!.verts[idx(r + 1, c + 1)];
        const da = dest[idx(r, c)], db = dest[idx(r, c + 1)];
        const dc = dest[idx(r + 1, c)], dd = dest[idx(r + 1, c + 1)];
        drawTri(a, b, cc, da, db, dc, crumple);
        drawTri(b, d, cc, db, dd, dc, crumple);
      }
    }
    ctx.restore();
  }

  function drawTri(p0: Vert, p1: Vert, p2: Vert, d0: Pt, d1: Pt, d2: Pt, crumple: number) {
    const m = affineFor(p0, p1, p2, d0, d1, d2);
    if (!m) return;
    const [i0, i1, i2] = inflate(d0, d1, d2, 0.6);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(i0.x, i0.y);
    ctx.lineTo(i1.x, i1.y);
    ctx.lineTo(i2.x, i2.y);
    ctx.closePath();
    ctx.clip();
    ctx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.drawImage(source!, 0, 0);
    ctx.restore();

    // Soft crease shading: smooth height -> gentle light/shadow.
    const shade = (p0.h + p1.h + p2.h) / 3;
    const alpha = smoothstep(0.05, 1, Math.abs(shade)) * 0.55 * crumple;
    if (alpha > 0.008) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(i0.x, i0.y);
      ctx.lineTo(i1.x, i1.y);
      ctx.lineTo(i2.x, i2.y);
      ctx.closePath();
      ctx.fillStyle = shade < 0 ? `rgba(18,20,26,${alpha})` : `rgba(255,255,255,${alpha * 0.75})`;
      ctx.fill();
      ctx.restore();
    }
  }

  function frame(now: number) {
    const t = now - animStart;
    const crumple = easeInOut(Math.min(1, t / DUR_CRUMPLE));
    const toss = Math.max(0, Math.min(1, (t - TOSS_START) / TOSS_DUR));
    drawCrumpled(crumple, toss);
    if (t < TOTAL) {
      requestAnimationFrame(frame);
    } else {
      resumeState.animState = 'gone';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      trashEl.classList.remove('shake');
      void trashEl.offsetWidth;
      trashEl.classList.add('shake');
      hintEl.classList.add('show');
    }
  }

  function startCrumple() {
    if (resumeState.animState !== 'idle' || !source) return;
    docLayer.style.display = 'none';  // text layer can't crumple
    mesh = buildMesh();
    resumeState.animState = 'running';
    animStart = performance.now();
    btn.disabled = true;
    requestAnimationFrame(frame);
  }

  function restore() {
    if (resumeState.animState !== 'gone') return;
    resumeState.animState = 'idle';
    hintEl.classList.remove('show');
    btn.disabled = false;
    docLayer.style.display = 'block';
    drawStatic();
  }

  btn.addEventListener('click', startCrumple);
  trashEl.addEventListener('click', restore);

  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  window.addEventListener('resize', () => {
    sizeStage();
    computeFit();
    placeDocLayer();
    if (resumeState.animState === 'idle') {
      drawStatic();
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(buildTextLayer, 150);
    } else if (resumeState.animState === 'gone') {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
    }
  });

  async function init() {
    sizeStage();
    try {
      const pdf = await pdfjsLib.getDocument(PDF_URL).promise;
      pdfPage = await pdf.getPage(1);
      pageBase = pdfPage.getViewport({ scale: 1 });

      const availW = window.innerWidth - MARGIN * 2;
      const availH = window.innerHeight - MARGIN * 2;
      const scale = Math.min(availW / pageBase.width, availH / pageBase.height) *
        Math.max(dpr, 2);
      const viewport = pdfPage.getViewport({ scale });

      source = document.createElement('canvas');
      source.width = Math.ceil(viewport.width);
      source.height = Math.ceil(viewport.height);
      const sctx = source.getContext('2d')!;
      sctx.fillStyle = '#fff';
      sctx.fillRect(0, 0, source.width, source.height);
      await pdfPage.render({ canvasContext: sctx, viewport }).promise;

      document.getElementById('loading')?.remove();
      computeFit();
      placeDocLayer();
      drawStatic();
      await buildTextLayer();
      btn.disabled = false;
    } catch (err: any) {
      const el = document.getElementById('loading');
      if (el) el.textContent = 'Could not load the resume PDF. ' + err.message;
    }
  }

  init();
}
