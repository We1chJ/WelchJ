import { useEffect } from 'react';
import FluidLens, { MagnifierFrame } from './FluidLens';
import { initResume } from './resume';

export default function App() {
  useEffect(() => { initResume(); }, []);

  return (
    <>
      <div id="loading">Loading resume…</div>
      <canvas id="stage" />

      <div id="docLayer">
        <div id="textLayer" className="textLayer" />
      </div>

      {/* WebGL glass lens overlay (pointer-events:none) + its brass frame */}
      <FluidLens />
      <MagnifierFrame />

      <button id="crumpleBtn" disabled>Crumple &amp; toss ↘</button>

      <div className="trash-hint">click bin to restore</div>
      <div id="trash" title="Restore resume">
        <svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
          <path d="M16 22 L48 22 L45 58 Q45 60 43 60 L21 60 Q19 60 19 58 Z"
            fill="#5b6470" stroke="#3c434d" strokeWidth="1.5" />
          <line x1="27" y1="28" x2="28" y2="54" stroke="#3c434d" strokeWidth="1.5" />
          <line x1="34" y1="28" x2="34" y2="54" stroke="#3c434d" strokeWidth="1.5" />
          <line x1="41" y1="28" x2="40" y2="54" stroke="#3c434d" strokeWidth="1.5" />
          <g className="lid">
            <rect x="12" y="16" width="40" height="7" rx="2" fill="#3c434d" />
            <rect x="27" y="11" width="10" height="5" rx="2" fill="#3c434d" />
          </g>
        </svg>
      </div>
    </>
  );
}
