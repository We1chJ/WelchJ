/* eslint-disable react/no-unknown-property */
// Interactive paper: a Verlet mass-spring sheet textured with the rendered
// resume. Grab any point and drag — structural + shear + bending constraints
// make it deform like a stiff sheet, and a soft return-to-rest spring springs
// it back flat (and keeps it readable) when released.
//
// Coordinate system: an orthographic camera where 1 world unit = 1 screen px,
// origin at screen centre, y-up. So a screen point (clientX, clientY) maps to
// world (clientX - W/2, H/2 - clientY) — no raycasting needed.
import * as THREE from 'three';
import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { resumeState } from './resume';

const GRID_W = 30;        // particles across; rows derived from paper aspect
const DAMP = 0.94;        // velocity retention per step
const ITER = 5;           // constraint relaxation passes per frame
const REST_ALPHA = 0.06;  // pull back toward the flat rest shape
const GRAB_RADIUS = 70;   // px; how close a click must be to grab a point
const LIFT = 50;          // px the grabbed point rises toward the viewer
const STRUCT_STIFF = 1.0;
const SHEAR_STIFF = 1.0;
const BEND_STIFF = 0.5;

interface Cloth {
  gw: number;
  gh: number;
  n: number;
  pos: Float32Array;
  prev: Float32Array;
  rest: Float32Array;
  la: Int32Array;       // link endpoints + rest length + stiffness
  lb: Int32Array;
  lrest: Float32Array;
  lstiff: Float32Array;
  geom: THREE.PlaneGeometry;
  w: number;            // window size the rest shape was built for
  h: number;
}

function buildCloth(): Cloth | null {
  const fit = resumeState.fit;
  if (!fit) return null;

  const W = window.innerWidth, H = window.innerHeight;
  const gw = GRID_W;
  const gh = Math.max(2, Math.round(gw * (fit.h / fit.w)));
  const n = gw * gh;

  const pos = new Float32Array(n * 3);
  const prev = new Float32Array(n * 3);
  const rest = new Float32Array(n * 3);

  for (let iy = 0; iy < gh; iy++) {
    for (let ix = 0; ix < gw; ix++) {
      const i = iy * gw + ix;
      const px = fit.x + (ix / (gw - 1)) * fit.w;
      const py = fit.y + (iy / (gh - 1)) * fit.h;
      const wx = px - W / 2;
      const wy = H / 2 - py;
      rest[i * 3] = pos[i * 3] = prev[i * 3] = wx;
      rest[i * 3 + 1] = pos[i * 3 + 1] = prev[i * 3 + 1] = wy;
      rest[i * 3 + 2] = pos[i * 3 + 2] = prev[i * 3 + 2] = 0;
    }
  }

  const la: number[] = [], lb: number[] = [], lrest: number[] = [], lstiff: number[] = [];
  const dist = (a: number, b: number) =>
    Math.hypot(rest[a * 3] - rest[b * 3], rest[a * 3 + 1] - rest[b * 3 + 1]);
  const link = (a: number, b: number, s: number) => {
    la.push(a); lb.push(b); lrest.push(dist(a, b)); lstiff.push(s);
  };
  for (let iy = 0; iy < gh; iy++) {
    for (let ix = 0; ix < gw; ix++) {
      const i = iy * gw + ix;
      if (ix < gw - 1) link(i, i + 1, STRUCT_STIFF);              // right
      if (iy < gh - 1) link(i, i + gw, STRUCT_STIFF);             // down
      if (ix < gw - 1 && iy < gh - 1) link(i, i + gw + 1, SHEAR_STIFF); // diag \
      if (ix > 0 && iy < gh - 1) link(i, i + gw - 1, SHEAR_STIFF);      // diag /
      if (ix < gw - 2) link(i, i + 2, BEND_STIFF);                // bend horiz
      if (iy < gh - 2) link(i, i + 2 * gw, BEND_STIFF);           // bend vert
    }
  }

  const geom = new THREE.PlaneGeometry(1, 1, gw - 1, gh - 1);
  return {
    gw, gh, n, pos, prev, rest,
    la: Int32Array.from(la), lb: Int32Array.from(lb),
    lrest: Float32Array.from(lrest), lstiff: Float32Array.from(lstiff),
    geom, w: W, h: H
  };
}

function Cloth() {
  const meshRef = useRef<THREE.Mesh>(null!);
  const matRef = useRef<THREE.MeshStandardMaterial>(null!);
  const cloth = useRef<Cloth | null>(null);
  const texRef = useRef<THREE.CanvasTexture | null>(null);
  const grabbed = useRef<number>(-1);
  const mouse = useRef({ x: 0, y: 0 });
  const prevAnim = useRef<string>('idle');
  const needsRebuild = useRef(false);

  // Pointer interaction (window-level; the lens overlay above is pointer-none).
  const downRef = useRef((e: MouseEvent) => {
    if (resumeState.animState !== 'idle' || !cloth.current) return;
    const t = e.target as HTMLElement | null;
    if (t && t.closest('#crumpleBtn, #trash')) return; // don't steal UI clicks
    const c = cloth.current;
    const mx = e.clientX - window.innerWidth / 2;
    const my = window.innerHeight / 2 - e.clientY;
    let best = -1, bestD = GRAB_RADIUS * GRAB_RADIUS;
    for (let i = 0; i < c.n; i++) {
      const dx = c.pos[i * 3] - mx, dy = c.pos[i * 3 + 1] - my;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0) {
      grabbed.current = best;
      mouse.current.x = mx; mouse.current.y = my;
      resumeState.dragging = true;
    }
  });
  const moveRef = useRef((e: MouseEvent) => {
    mouse.current.x = e.clientX - window.innerWidth / 2;
    mouse.current.y = window.innerHeight / 2 - e.clientY;
  });
  const upRef = useRef(() => { grabbed.current = -1; resumeState.dragging = false; });

  // Attach once.
  const attached = useRef(false);
  if (!attached.current && typeof window !== 'undefined') {
    attached.current = true;
    window.addEventListener('mousedown', downRef.current);
    window.addEventListener('mousemove', moveRef.current);
    window.addEventListener('mouseup', upRef.current);
    window.addEventListener('resize', () => { needsRebuild.current = true; });
  }

  useFrame(() => {
    // Build / rebuild once the PDF bitmap + fit are ready (and on resize).
    if (resumeState.source && (!cloth.current || needsRebuild.current)) {
      needsRebuild.current = false;
      const c = buildCloth();
      if (c) {
        cloth.current = c;
        meshRef.current.geometry.dispose();
        meshRef.current.geometry = c.geom;
        if (!texRef.current) {
          const t = new THREE.CanvasTexture(resumeState.source);
          t.colorSpace = THREE.SRGBColorSpace;
          t.anisotropy = 4;
          texRef.current = t;
          matRef.current.map = t;
          matRef.current.needsUpdate = true;
        }
      }
    }
    const c = cloth.current;
    if (!c) return;

    const idle = resumeState.animState === 'idle';
    meshRef.current.visible = idle;

    // Flatten when returning from a crumple so the sheet is pristine again.
    if (idle && prevAnim.current !== 'idle') {
      c.pos.set(c.rest); c.prev.set(c.rest); grabbed.current = -1;
    }
    prevAnim.current = resumeState.animState;
    if (!idle) return;

    const { pos, prev, rest, la, lb, lrest, lstiff, n } = c;
    const g = grabbed.current;

    // Verlet integration (grabbed point is driven by the mouse instead).
    for (let i = 0; i < n; i++) {
      if (i === g) continue;
      for (let k = 0; k < 3; k++) {
        const idx = i * 3 + k;
        const v = (pos[idx] - prev[idx]) * DAMP;
        prev[idx] = pos[idx];
        pos[idx] += v;
      }
    }
    if (g >= 0) {
      pos[g * 3] = prev[g * 3] = mouse.current.x;
      pos[g * 3 + 1] = prev[g * 3 + 1] = mouse.current.y;
      pos[g * 3 + 2] = prev[g * 3 + 2] = LIFT;
    }

    // Constraint relaxation: keep link lengths ~ rest (inextensible paper).
    for (let pass = 0; pass < ITER; pass++) {
      for (let l = 0; l < la.length; l++) {
        const a = la[l], b = lb[l];
        const ax = a * 3, bx = b * 3;
        let dx = pos[bx] - pos[ax];
        let dy = pos[bx + 1] - pos[ax + 1];
        let dz = pos[bx + 2] - pos[ax + 2];
        const d = Math.hypot(dx, dy, dz) || 1e-6;
        const diff = ((d - lrest[l]) / d) * 0.5 * lstiff[l];
        dx *= diff; dy *= diff; dz *= diff;
        if (a !== g) { pos[ax] += dx; pos[ax + 1] += dy; pos[ax + 2] += dz; }
        if (b !== g) { pos[bx] -= dx; pos[bx + 1] -= dy; pos[bx + 2] -= dz; }
      }
    }

    // Soft pull back to the flat rest shape (stiffness + readability).
    for (let i = 0; i < n; i++) {
      if (i === g) continue;
      const idx = i * 3;
      pos[idx] += (rest[idx] - pos[idx]) * REST_ALPHA;
      pos[idx + 1] += (rest[idx + 1] - pos[idx + 1]) * REST_ALPHA;
      pos[idx + 2] += (rest[idx + 2] - pos[idx + 2]) * REST_ALPHA;
    }

    // Push positions into the mesh and reshade.
    const attr = c.geom.attributes.position as THREE.BufferAttribute;
    (attr.array as Float32Array).set(pos);
    attr.needsUpdate = true;
    c.geom.computeVertexNormals();
  });

  return (
    <mesh ref={meshRef} frustumCulled={false} visible={false}>
      <planeGeometry args={[1, 1, 1, 1]} />
      <meshStandardMaterial ref={matRef} roughness={0.85} metalness={0} side={THREE.DoubleSide} />
    </mesh>
  );
}

export default function PaperCloth() {
  return (
    <Canvas
      orthographic
      camera={{ zoom: 1, position: [0, 0, 100], near: 0.1, far: 1000 }}
      gl={{ alpha: true, antialias: true, preserveDrawingBuffer: true }}
      dpr={[1, 2]}
      flat
      onCreated={({ gl }) => { resumeState.clothCanvas = gl.domElement; }}
      style={{ position: 'fixed', inset: 0, zIndex: 1 }}
    >
      <ambientLight intensity={0.8} />
      <directionalLight position={[-0.4, 0.7, 1]} intensity={1.1} />
      <Cloth />
    </Canvas>
  );
}
