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

function Lens() {
  const ref = useRef<THREE.Mesh>(null!);
  const planeMat = useRef<THREE.MeshBasicMaterial>(null!);
  const { nodes } = useGLTF(GLB) as unknown as { nodes: Record<string, THREE.Mesh> };
  const buffer = useFBO();
  const { viewport: vp } = useThree();
  const [scene] = useState(() => new THREE.Scene());
  const texRef = useRef<THREE.CanvasTexture | null>(null);

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
    const stage = resumeState.stage;

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

    const show =
      !!stage && !!texRef.current && pointer.current.over && resumeState.animState === 'idle';

    // Hide the system cursor only while the glass stands in for it.
    document.body.classList.toggle('lens-active', show);

    if (!show) { ref.current.visible = false; return; }
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
