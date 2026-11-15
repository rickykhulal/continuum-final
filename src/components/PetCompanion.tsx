import { Component, Suspense, useState, useEffect, useLayoutEffect, useRef, useCallback, type ReactNode, type PointerEvent } from 'react';
import { Canvas, useLoader } from '@react-three/fiber';
import { Bounds, Environment, Lightformer } from '@react-three/drei';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import * as THREE from 'three';
import { useStore } from '../lib/store';

const FACTS = [
  'Did you know? MODIS active-fire pixels are about 1 km.',
  'VIIRS active-fire pixels are 375 m.',
  'FRP is fire radiative power, measured in megawatts.',
  'Continuum labels archive observations, the live window, and calibrated reconstruction separately.',
  'Open-Meteo supplies current wind forecasts; NASA POWER supplies historical reanalysis.',
  'Woof! A hotspot detection is not the same as a separate fire.',
  'MODIS and VIIRS use different sensors, so comparisons need calibration.',
  'Freshness matters: Continuum labels its seven-day observed window.',
  'Did you know? NASA launched Terra in December 1999.',
  'Woof! MODIS stands for Moderate Resolution Imaging Spectroradiometer.',
  'VIIRS stands for Visible Infrared Imaging Radiometer Suite.',
  'A 375 m VIIRS fire pixel describes the sampling scale, not the exact size of the fire.',
  'Hot, dry and windy weather can make fires easier to ignite and spread.',
  'Clouds can hide a fire from a satellite. No detection does not prove there is no fire.',
  'NASA Aqua launched in 2002 and carries a MODIS instrument.',
  'Suomi NPP launched in 2011 and carries the first VIIRS instrument.',
  'More sensitive sensors can raise detection counts without a matching rise in real fire activity.',
  'Continuum uses overlap observations to calibrate comparisons across the MODIS–VIIRS transition.',
  'A polar-orbiting satellite revisits an area on later passes; it does not watch every spot continuously.',
  'Wind direction tells us where the wind comes from: a north wind blows toward the south.',
  'Fire radiative power measures the rate of radiant energy release, not the total burned area.',
  'A seasonal risk calendar describes historical patterns. It cannot predict an individual ignition.',
];

const FACT_INTERVAL_MS = 45_000;
const FACT_DURATION_MS = 10_000;

interface PetCompanionProps {
  size?: number;
}

function PetModel() {
  // Float the whole DOM handle so the model and tether share one screen-space position.
  const { scene } = useLoader(GLTFLoader, `${import.meta.env.BASE_URL || './'}models/pet1.glb`);
  return <primitive object={scene} />;
}

class PetSceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? <div style={{ fontSize: 64, textAlign: 'center' }}>🐶</div> : this.props.children;
  }
}

export function PetCompanion({ size = 150 }: PetCompanionProps) {
  const { settings } = useStore();
  const [talking, setTalking] = useState(false);
  const [fact, setFact] = useState('');
  const lastFactIndex = useRef(-1);
  const hideFactTimer = useRef<number | null>(null);
  const tether = useRef<SVGSVGElement>(null);
  const handle = useRef<HTMLDivElement>(null);
  const floatOffset = useRef(0);
  const width = () => Math.min(size, Math.max(0, window.innerWidth - 40));
  const clamp = (left: number, top: number) => ({
    left: Math.max(0, Math.min(left, window.innerWidth - width())),
    top: Math.max(0, Math.min(top, window.innerHeight - size)),
  });
  const anchor = () => clamp(window.innerWidth - width() - 20, window.innerHeight - size - (window.innerWidth <= 700 ? 170 : 120));
  const [position, setPosition] = useState(anchor);
  const positionRef = useRef(position);
  const drawTether = useCallback(() => {
    const x = positionRef.current.left + Math.min(size, Math.max(0, window.innerWidth - 40)) / 2;
    const y = positionRef.current.top + size / 2 + floatOffset.current;
    const endX = window.innerWidth, endY = window.innerHeight;
    const bend = Math.min(160, Math.max(40, (endX - x) / 3));
    const curve = `M ${endX} ${endY} C ${endX - bend} ${endY}, ${x + bend} ${y + 60}, ${x} ${y}`;
    tether.current?.querySelectorAll('path').forEach(path => path.setAttribute('d', curve));
    const socket = tether.current?.querySelector('circle');
    socket?.setAttribute('cx', String(x));
    socket?.setAttribute('cy', String(y));
    if (handle.current) handle.current.style.transform = `translateY(${floatOffset.current}px)`;
  }, [size]);
  useLayoutEffect(() => {
    positionRef.current = position;
    drawTether();
  }, [position, drawTether]);
  useEffect(() => {
    let frame: number;
    const animate = (time: number) => {
      floatOffset.current = settings.reduceMotion ? 0 : Math.sin(time / 1000) * 5;
      drawTether();
      if (!settings.reduceMotion) frame = requestAnimationFrame(animate);
    };
    animate(performance.now());
    window.addEventListener('resize', drawTether);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('resize', drawTether); };
  }, [settings.reduceMotion, drawTether]);
  const userMoved = useRef(false);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);

  useEffect(() => {
    const resize = () => setPosition(p => userMoved.current ? clamp(p.left, p.top) : anchor());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [size]);

  const showFact = useCallback(() => {
    // Pick from the remaining facts so consecutive visits never repeat one.
    let index = Math.floor(Math.random() * (FACTS.length - (lastFactIndex.current < 0 ? 0 : 1)));
    if (lastFactIndex.current >= 0 && index >= lastFactIndex.current) index++;
    lastFactIndex.current = index;
    if (hideFactTimer.current !== null) window.clearTimeout(hideFactTimer.current);
    setFact(FACTS[index]);
    setTalking(true);
    hideFactTimer.current = window.setTimeout(() => {
      setTalking(false);
      setFact('');
      hideFactTimer.current = null;
    }, FACT_DURATION_MS);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(showFact, FACT_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      if (hideFactTimer.current !== null) {
        window.clearTimeout(hideFactTimer.current);
        hideFactTimer.current = null;
      }
    };
  }, [showFact]);

  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, ...position, moved: false };
    setDragging(true);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    start.moved ||= Math.hypot(dx, dy) > 5;
    if (start.moved) {
      userMoved.current = true;
      setPosition(clamp(start.left + dx, start.top + dy));
    }
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = drag.current;
    if (!start || start.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === 'pointerup' && !start.moved) showFact();
  };

  return (
    <aside
      className="pet-companion"
      aria-label="Laika companion"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        pointerEvents: 'none',
        overflow: 'visible',
      }}
    >
      <svg
        ref={tether}
        className="pet-oxygen-pipe"
        aria-hidden="true"
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}
      >
        <path d="" fill="none" stroke="#19bdca" strokeWidth="6" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 5px #29e0ee)' }} />
        <path d="" fill="none" stroke="#bdffff" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx={position.left + width() / 2} cy={position.top + size / 2} r="4" fill="#baffff" />
      </svg>
      <div
        ref={handle}
        className="pet-drag-handle"
        role="button"
        tabIndex={0}
        aria-label="Laika shares a fire science fact every 45 seconds; drag or use arrow keys to move; Enter asks for another fact"
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={pointerUp}
        onPointerCancel={pointerUp}
        onLostPointerCapture={() => { drag.current = null; setDragging(false); }}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); showFact(); }
          if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            userMoved.current = true;
            setPosition(p => clamp(p.left + (event.key === 'ArrowRight' ? 20 : event.key === 'ArrowLeft' ? -20 : 0), p.top + (event.key === 'ArrowDown' ? 20 : event.key === 'ArrowUp' ? -20 : 0)));
          }
        }}
        style={{ position: 'absolute', ...position, width: `min(${size}px, calc(100vw - 40px))`, height: size, pointerEvents: 'auto', cursor: dragging ? 'grabbing' : 'grab', touchAction: 'none', userSelect: 'none' }}
      >
        <PetSceneBoundary>
          <Canvas
            dpr={[1, 1.5]}
            camera={{ position: [0, 0, 3], fov: 40 }}
            gl={{ alpha: true, toneMapping: THREE.ACESFilmicToneMapping }}
            fallback={<div style={{ fontSize: 64, textAlign: 'center' }}>🐶</div>}
            style={{ width: '100%', height: '100%', display: 'block', background: 'transparent' }}
          >
            <ambientLight intensity={1.5} />
            <directionalLight position={[10, 10, 10]} intensity={3} />
            <spotLight position={[-10, 10, 10]} intensity={2} />
            {/* Local studio reflections brighten metallic textures without a remote HDR dependency. */}
            <Environment resolution={64} frames={1}>
              <Lightformer position={[0, 3, 4]} scale={[5, 5, 1]} intensity={2} />
              <Lightformer position={[-4, 1, 0]} rotation={[0, Math.PI / 2, 0]} scale={[4, 4, 1]} intensity={2} />
              <Lightformer position={[4, 1, 0]} rotation={[0, -Math.PI / 2, 0]} scale={[4, 4, 1]} intensity={1.5} />
            </Environment>
            <Suspense fallback={null}>
              <Bounds fit clip observe margin={1.4} maxDuration={0}>
                <PetModel />
              </Bounds>
            </Suspense>
          </Canvas>
        </PetSceneBoundary>
      {talking && (
        <div
          className="pet-speech-bubble"
          role="status"
          style={{
            position: 'absolute',
            bottom: position.top < 110 ? undefined : 'calc(100% + 12px)',
            top: position.top < 110 ? 'calc(100% + 12px)' : undefined,
            left: position.left < 110 ? 0 : undefined,
            right: position.left < 110 ? undefined : 0,
          }}
        >
          {fact}
        </div>
      )}
      </div>
    </aside>
  );
}
