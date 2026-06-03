/* eslint-disable react/no-unknown-property */
// Cursor-following glass lens, adapted from React Bits' FluidGlass.
// Difference from the stock component: instead of refracting its own demo
// gallery, it textures the live resume <canvas> into an off-screen scene,
// renders that to an FBO, and refracts THAT through the lens — so the glass
// shows your actual resume. The lens only appears while the cursor is over the
// resume and no crumple animation is running.
import * as THREE from 'three';
import { useRef, useState, useEffect } from 'react';
import { Canvas, createPortal, useFrame, useThree } from '@react-three/fiber';
import { useFBO, useGLTF, MeshTransmissionMaterial, Preload } from '@react-three/drei';
import { easing } from 'maath';
import { resumeState } from './resume';

const GLB = '/assets/3d/lens.glb';
const LENS_SCALE = 0.22;
useGLTF.preload(GLB);

// The SVG magnifier ring is authored with this inner radius (user units); the
// frame is scaled so this maps exactly onto the glass circle's screen radius.
const FRAME_BASE_R = 100;
// Shared handle to the DOM magnifier frame, driven each render frame by Lens so
// it stays pixel-aligned with the (damped) WebGL glass circle.
export const lensFrameEl = { current: null as HTMLDivElement | null };

const _c = new THREE.Vector3();
const _e = new THREE.Vector3();

function Lens() {
  const ref = useRef<THREE.Mesh>(null!);
  const planeMat = useRef<THREE.MeshBasicMaterial>(null!);
  const { nodes } = useGLTF(GLB) as unknown as { nodes: Record<string, THREE.Mesh> };
  const buffer = useFBO();
  const { viewport: vp } = useThree();
  const [scene] = useState(() => new THREE.Scene());
  const texRef = useRef<THREE.CanvasTexture | null>(null);
  const worldR = useRef(0); // glass circle radius in world units

  // Pointer is tracked on window because the overlay canvas is pointer-events:none
  // (so the crumple button / trash stay clickable). NDC + hover-over-resume flag.
  const pointer = useRef({ x: 0, y: 0, over: false });
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      pointer.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointer.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
      const f = resumeState.fit;
      pointer.current.over =
        !!f && e.clientX >= f.x && e.clientX <= f.x + f.w &&
        e.clientY >= f.y && e.clientY <= f.y + f.h;
    };
    const onLeave = () => { pointer.current.over = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseleave', onLeave);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseleave', onLeave);
    };
  }, []);

  useFrame((state, delta) => {
    const { gl, camera } = state;
    const stage = resumeState.clothCanvas;

    // Lazily create the resume texture once the canvas exists.
    if (stage && !texRef.current) {
      const t = new THREE.CanvasTexture(stage);
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
      texRef.current = t;
      if (planeMat.current) { planeMat.current.map = t; planeMat.current.needsUpdate = true; }
    }

    // Cache the glass circle's world radius from the lens geometry (once).
    if (worldR.current === 0 && nodes.Cylinder) {
      const g = nodes.Cylinder.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox!;
      worldR.current = ((bb.max.x - bb.min.x) / 2) * LENS_SCALE;
    }

    const show =
      resumeState.lensEnabled &&
      !!stage && !!texRef.current && pointer.current.over &&
      resumeState.animState === 'idle' && !resumeState.dragging;

    // Hide the system cursor only while the glass stands in for it.
    document.body.classList.toggle('lens-active', show);

    if (!show) {
      ref.current.visible = false;
      if (lensFrameEl.current) lensFrameEl.current.style.opacity = '0';
      return;
    }
    ref.current.visible = true;

    // Keep the off-screen copy of the resume current, then render it to the FBO.
    texRef.current!.needsUpdate = true;
    gl.setRenderTarget(buffer);
    gl.render(scene, camera);
    gl.setRenderTarget(null);

    // Follow the cursor at the lens plane (z = 15), snappily.
    const v = state.viewport.getCurrentViewport(camera, [0, 0, 15]);
    const destX = (pointer.current.x * v.width) / 2;
    const destY = (pointer.current.y * v.height) / 2;
    easing.damp3(ref.current.position, [destX, destY, 15], 0.08, delta);

    // Drive the DOM magnifier frame from the SAME damped position so the brass
    // ring sits exactly on the glass circle. Project the lens centre and a rim
    // point to screen pixels, then position + scale the frame to match.
    const el = lensFrameEl.current;
    if (el) {
      const p = ref.current.position;
      _c.set(p.x, p.y, p.z).project(camera);
      _e.set(p.x + worldR.current, p.y, p.z).project(camera);
      const cx = (_c.x * 0.5 + 0.5) * window.innerWidth;
      const cy = (-_c.y * 0.5 + 0.5) * window.innerHeight;
      const ex = (_e.x * 0.5 + 0.5) * window.innerWidth;
      const ey = (-_e.y * 0.5 + 0.5) * window.innerHeight;
      const rPx = Math.hypot(ex - cx, ey - cy);
      el.style.opacity = '1';
      el.style.transform =
        `translate(${cx}px, ${cy}px) translate(-50%, -50%) scale(${rPx / FRAME_BASE_R})`;
    }
  });

  return (
    <>
      {createPortal(
        <mesh scale={[vp.width, vp.height, 1]}>
          <planeGeometry />
          <meshBasicMaterial ref={planeMat} toneMapped={false} />
        </mesh>,
        scene
      )}
      <mesh
        ref={ref}
        visible={false}
        scale={LENS_SCALE}
        rotation-x={Math.PI / 2}
        geometry={nodes.Cylinder?.geometry}
      >
        <MeshTransmissionMaterial
          buffer={buffer.texture}
          transmission={1}
          roughness={0}
          ior={1.2}
          thickness={2.6}
          anisotropy={0}
          chromaticAberration={0.04}
        />
      </mesh>
    </>
  );
}

export default function FluidLens() {
  return (
    <Canvas
      id="lensOverlay"
      flat
      camera={{ position: [0, 0, 20], fov: 15 }}
      gl={{ alpha: true }}
      dpr={[1, 2]}
      style={{ position: 'fixed', inset: 0, zIndex: 3, pointerEvents: 'none' }}
    >
      <Lens />
      <Preload all />
    </Canvas>
  );
}

// DOM magnifier frame (brass ring + wooden handle) overlaid on the glass circle.
// Its position/scale are driven imperatively by Lens (via lensFrameEl) each
// frame, so it tracks the damped glass exactly. The ring's inner edge is at
// FRAME_BASE_R, which is scaled onto the glass radius — hence perfect overlap.
export function MagnifierFrame() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    lensFrameEl.current = ref.current;
    return () => { lensFrameEl.current = null; };
  }, []);

  return (
    <div
      ref={ref}
      aria-hidden
      style={{
        position: 'fixed',
        left: 0,
        top: 0,
        width: 520,
        height: 520,
        zIndex: 4,
        pointerEvents: 'none',
        opacity: 0,
        willChange: 'transform, opacity'
      }}
    >
      <svg width={520} height={520} viewBox="0 0 520 520" fill="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          {/* Brushed-steel band: bright top, dark belly, faint bottom kick. */}
          <linearGradient id="mfSilver" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbfdff" />
            <stop offset="10%" stopColor="#e2e7ed" />
            <stop offset="26%" stopColor="#bcc2cc" />
            <stop offset="44%" stopColor="#888e98" />
            <stop offset="56%" stopColor="#6a707a" />
            <stop offset="70%" stopColor="#565b64" />
            <stop offset="84%" stopColor="#9298a1" />
            <stop offset="100%" stopColor="#c4c9d1" />
          </linearGradient>
          <linearGradient id="mfSilverV" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#eef1f5" />
            <stop offset="50%" stopColor="#aab0b9" />
            <stop offset="100%" stopColor="#70757e" />
          </linearGradient>
          {/* Handle across its width -> cylindrical brown rod. */}
          <linearGradient id="mfWood" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2a1809" />
            <stop offset="20%" stopColor="#4a2e18" />
            <stop offset="50%" stopColor="#6f4827" />
            <stop offset="78%" stopColor="#432817" />
            <stop offset="100%" stopColor="#261507" />
          </linearGradient>
          <filter id="mfShadow" x="-25%" y="-25%" width="150%" height="150%">
            <feDropShadow dx="0" dy="4" stdDeviation="5" floodColor="#000" floodOpacity="0.4" />
          </filter>
        </defs>

        <g filter="url(#mfShadow)">
          {/* Handle: drawn first so the ring overlaps its collar cleanly.
              Points south, rotated 45° -> sits to the bottom-right. */}
          <g transform="rotate(45 260 260)">
            <rect x="248" y="404" width="24" height="120" rx="12" fill="url(#mfWood)" stroke="#1f1305" strokeWidth="1" />
            <rect x="256" y="410" width="3" height="108" rx="1.5" fill="#9a6636" opacity="0.4" />
            {/* Silver ferrule (collar) joining handle to the ring. */}
            <rect x="245" y="370" width="30" height="38" rx="7" fill="url(#mfSilverV)" stroke="#4a4e55" strokeWidth="1" />
            <rect x="245" y="379" width="30" height="1.5" fill="#5b6068" opacity="0.6" />
            <rect x="245" y="398" width="30" height="1.5" fill="#5b6068" opacity="0.6" />
          </g>

          {/* Silver ring: inner edge at r=100 (= glass silhouette). */}
          <circle cx="260" cy="260" r="105" fill="none" stroke="url(#mfSilver)" strokeWidth="10" />
          <circle cx="260" cy="260" r="110" fill="none" stroke="#4d525a" strokeWidth="1.5" opacity="0.8" />
          <circle cx="260" cy="260" r="100" fill="none" stroke="#3a3f46" strokeWidth="1.5" opacity="0.85" />
          <circle cx="260" cy="260" r="102" fill="none" stroke="#dfe5ec" strokeWidth="1" opacity="0.4" />
          {/* Primary specular on the upper-left, faint secondary lower-right. */}
          <circle
            cx="260" cy="260" r="105" fill="none"
            stroke="#ffffff" strokeWidth="3" strokeLinecap="round"
            strokeDasharray="144 516" transform="rotate(-125 260 260)" opacity="0.85"
          />
          <circle
            cx="260" cy="260" r="105" fill="none"
            stroke="#eef3f8" strokeWidth="2" strokeLinecap="round"
            strokeDasharray="86 574" transform="rotate(40 260 260)" opacity="0.45"
          />
        </g>
      </svg>
    </div>
  );
}
