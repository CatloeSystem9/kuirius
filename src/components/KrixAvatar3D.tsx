import React, { useRef, useEffect, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRM, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import { AvatarExpression, EmotionAnalysis } from '../types';

// ── Public event bus for voice ↔ avatar lip sync ───────────────────────────────
export type KrixLipSyncCallback = (volume: number) => void;
let _lipSyncCb: KrixLipSyncCallback | null = null;
export function registerKrixLipSync(cb: KrixLipSyncCallback) { _lipSyncCb = cb; }
export function unregisterKrixLipSync() { _lipSyncCb = null; }
export function pushKrixLipSyncVolume(v: number) { _lipSyncCb?.(v); }

// ── Audio analyser singleton (Web Audio API) ───────────────────────────────────
let _audioCtx: AudioContext | null = null;
let _analyser: AnalyserNode | null = null;
let _animFrameId: number | null = null;
let _sourceNode: MediaElementAudioSourceNode | null = null;
let _connectedElement: HTMLAudioElement | null = null;

function ensureAudioContext(): AudioContext {
  if (!_audioCtx || _audioCtx.state === 'closed') {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    _audioCtx = new Ctor();
  }
  if (_audioCtx.state === 'suspended') _audioCtx.resume().catch(() => {});
  return _audioCtx;
}

/** Start analysing an HTMLAudioElement (Gemini TTS path). */
export function startKrixAudioAnalysis(audio: HTMLAudioElement) {
  stopKrixAudioAnalysis();
  try {
    const ctx = ensureAudioContext();
    _analyser = ctx.createAnalyser();
    _analyser.fftSize = 256;
    _analyser.smoothingTimeConstant = 0.6;

    if (_connectedElement !== audio) {
      _sourceNode = ctx.createMediaElementSource(audio);
      _connectedElement = audio;
    }
    _sourceNode!.connect(_analyser);
    _analyser.connect(ctx.destination);

    const dataArray = new Uint8Array(_analyser.frequencyBinCount);
    const pump = () => {
      if (!_analyser) return;
      _analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      const count = Math.min(32, dataArray.length);
      for (let i = 0; i < count; i++) sum += dataArray[i];
      const avg = sum / count / 255;
      pushKrixLipSyncVolume(avg);
      _animFrameId = requestAnimationFrame(pump);
    };
    pump();
  } catch (e) {
    console.warn('[KrixAvatar] Audio analysis setup failed:', e);
  }
}

/** Stop audio analysis loop. */
export function stopKrixAudioAnalysis() {
  if (_animFrameId !== null) {
    cancelAnimationFrame(_animFrameId);
    _animFrameId = null;
  }
  if (_sourceNode && _analyser) {
    try { _sourceNode.disconnect(_analyser); } catch {}
  }
  if (_analyser) {
    try { _analyser.disconnect(); } catch {}
    _analyser = null;
  }
  pushKrixLipSyncVolume(0);
}

// ── Supported VRM 1.0 Expressions in Krix3.vrm ─────────────────────────────────
export const SUPPORTED_VRM_EXPRESSIONS = [
  'happy',
  'relaxed',
  'surprised',
  'sad',
  'angry',
  'neutral',
  'aa',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
] as const;

export type SupportedVrmExpression = typeof SUPPORTED_VRM_EXPRESSIONS[number];

// ── Component props ────────────────────────────────────────────────────────────
export interface KrixAvatarProps {
  expression?: AvatarExpression;
  emotionData?: EmotionAnalysis;
  isSpeaking: boolean;
  isListening?: boolean;
  isDancing?: boolean;
  isGreeting?: boolean;
  isThanked?: boolean;
  lookDirection?: 'different_directions' | 'left' | 'right' | 'up' | 'down' | 'around' | null;
  pointerPos?: { x: number; y: number };
}

const VRM_MODEL_PATH = '/model/Krix3.vrm';

// ── The KrixAvatar 3D Component ────────────────────────────────────────────────
export const KrixAvatar: React.FC<KrixAvatarProps> = ({
  expression = 'gentle_smile',
  emotionData,
  isSpeaking,
  isListening = false,
  isDancing = false,
  isGreeting = false,
  isThanked = false,
  lookDirection = null,
  pointerPos = { x: 0, y: 0 },
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const vrmRef = useRef<VRM | null>(null);
  const lookAtTargetRef = useRef<THREE.Object3D | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const rafRef = useRef<number>(0);
  const lipVolumeRef = useRef(0);
  const mountedRef = useRef(true);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [loadProgress, setLoadProgress] = useState(0);

  // Expression review state (lets developer or user review expressions directly)
  const [activeTestExpression, setActiveTestExpression] = useState<string | null>(null);
  const [showExpressionTester, setShowExpressionTester] = useState(false);
  const activeTestExprRef = useRef<string | null>(null);
  useEffect(() => { activeTestExprRef.current = activeTestExpression; }, [activeTestExpression]);

  // Keep latest props in refs for animation loop
  const speakingRef = useRef(isSpeaking);
  useEffect(() => { speakingRef.current = isSpeaking; }, [isSpeaking]);

  const expressionRef = useRef(expression);
  useEffect(() => { expressionRef.current = expression; }, [expression]);

  const emotionDataRef = useRef(emotionData);
  useEffect(() => { emotionDataRef.current = emotionData; }, [emotionData]);

  const pointerRef = useRef(pointerPos);
  useEffect(() => { pointerRef.current = pointerPos; }, [pointerPos]);

  const lookDirectionRef = useRef(lookDirection);
  useEffect(() => { lookDirectionRef.current = lookDirection; }, [lookDirection]);

  // Register lip sync volume receiver
  useEffect(() => {
    registerKrixLipSync((v) => { lipVolumeRef.current = v; });
    return () => { unregisterKrixLipSync(); };
  }, []);

  // Expose global test helpers for developer console & automated tests
  useEffect(() => {
    (window as any).__krixSetExpression = (exprName: string | null) => {
      setActiveTestExpression(exprName);
    };
    (window as any).__krixGetExpressions = () => SUPPORTED_VRM_EXPRESSIONS;
    (window as any).__krixIsLoaded = () => Boolean(vrmRef.current);
    return () => {
      delete (window as any).__krixSetExpression;
      delete (window as any).__krixGetExpressions;
      delete (window as any).__krixIsLoaded;
    };
  }, []);

  // ── Initialise Three.js Scene + VRM Loader ──────────────────────────────────
  useEffect(() => {
    mountedRef.current = true;
    const container = containerRef.current;
    if (!container) return;

    // 1. Scene
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // 2. Camera: Full body framing so the whole character fits comfortably into view
    // Model total height is 1.72m, centered around y = 0.86m.
    // Placing camera at y = 0.88m, distance z = 3.85m with fov = 28° gives a vertical
    // span of 1.92m (from y = -0.08m below feet to y = 1.84m above top of hair).
    const initialWidth = container.clientWidth || 400;
    const initialHeight = container.clientHeight || 580;
    const camera = new THREE.PerspectiveCamera(28, initialWidth / initialHeight, 0.1, 50);
    camera.position.set(0, 0.88, 3.85);
    camera.lookAt(0, 0.86, 0);
    cameraRef.current = camera;

    // 3. Renderer with transparent background and clamped pixel ratio
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        powerPreference: 'default',
      });
    } catch {
      setLoadError('WebGL is not available in this browser environment.');
      return;
    }
    renderer.setSize(initialWidth, initialHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.15;
    rendererRef.current = renderer;
    container.appendChild(renderer.domElement);

    // 4. Lighting: Flattering full-body lighting matching Krisha palette
    // Soft cool ambient light for even coverage from head to toe
    const ambientLight = new THREE.AmbientLight(0xc8d8f8, 1.0);
    scene.add(ambientLight);

    // Key front-right directional light illuminating face & body
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(0.8, 2.2, 2.5);
    scene.add(keyLight);

    // Electric-cyan fill light on the left
    const cyanFillLight = new THREE.DirectionalLight(0x38bdf8, 0.85);
    cyanFillLight.position.set(-1.6, 1.4, 2.2);
    scene.add(cyanFillLight);

    // Lower fill light for dress, legs and shoes
    const lowerFillLight = new THREE.DirectionalLight(0x88b0f8, 0.5);
    lowerFillLight.position.set(0, 0.4, 2.0);
    scene.add(lowerFillLight);

    // Back rim light to outline hair and silhouette
    const rimLight = new THREE.DirectionalLight(0x00d4ff, 0.85);
    rimLight.position.set(0, 1.8, -2.0);
    scene.add(rimLight);

    // Dedicated LookAt Target for Cursor Eye-Tracking
    // Only eyes follow this target; neck does NOT follow.
    const lookAtTarget = new THREE.Object3D();
    lookAtTarget.position.set(0, 1.52, 2.0);
    scene.add(lookAtTarget);
    lookAtTargetRef.current = lookAtTarget;

    // 5. Load VRM model locally from /model/Krix3.vrm
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      VRM_MODEL_PATH,
      (gltf) => {
        if (!mountedRef.current) return;
        const vrm = gltf.userData.vrm as VRM;
        if (!vrm) {
          setLoadError('Failed to parse VRM data from the model file.');
          return;
        }

        // ── Orientation ─────────────────────────────────────────────────────
        // In VRM 1.0 (VRMC_vrm), model face coordinates naturally face +Z.
        // VRMUtils.rotateVRM0(vrm) rotates by Math.PI ONLY if VRM 0.0.
        // For VRM 1.0, rotation.y remains 0, directly facing our camera at +Z.
        VRMUtils.rotateVRM0(vrm);
        vrm.scene.rotation.y = 0;
        scene.add(vrm.scene);
        vrmRef.current = vrm;

        // Setup VRMLookAt eye tracking target
        if (vrm.lookAt) {
          vrm.lookAt.target = lookAtTarget;
          vrm.lookAt.autoUpdate = true;
        }

        // Initialize natural relaxed standing pose (T-pose fix)
        const humanoid = vrm.humanoid;
        if (humanoid) {
          const leftUpperArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
          const rightUpperArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
          const leftLowerArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
          const rightLowerArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
          const leftHand = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);
          const rightHand = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightHand);

          if (leftUpperArm) leftUpperArm.rotation.set(0.08, -0.05, -1.25);
          if (rightUpperArm) rightUpperArm.rotation.set(0.08, 0.05, 1.25);
          if (leftLowerArm) leftLowerArm.rotation.set(0, -0.32, 0.05);
          if (rightLowerArm) rightLowerArm.rotation.set(0, 0.32, -0.05);
          if (leftHand) leftHand.rotation.set(-0.05, 0, -0.05);
          if (rightHand) rightHand.rotation.set(-0.05, 0, 0.05);
        }

        setIsLoaded(true);
      },
      (event) => {
        if (event.total > 0) {
          setLoadProgress(Math.round((event.loaded / event.total) * 100));
        }
      },
      (err) => {
        console.error('[KrixAvatar] VRM load error:', err);
        setLoadError(`Failed to load VRM model: ${(err as Error)?.message || 'Unknown error'}`);
      }
    );

    // 6. Responsive resize via ResizeObserver
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = entry.contentRect.width;
        const h = entry.contentRect.height;
        if (w > 0 && h > 0 && cameraRef.current && rendererRef.current) {
          cameraRef.current.aspect = w / h;
          cameraRef.current.updateProjectionMatrix();
          rendererRef.current.setSize(w, h);
        }
      }
    });
    resizeObserver.observe(container);

    // ── Animation Loop ────────────────────────────────────────────────────────
    let time = 0;

    // Blinking state
    let blinkTimer = 0;
    let nextBlinkAt = 2.5 + Math.random() * 3.5;
    let blinkPhase: 'idle' | 'closing' | 'opening' = 'idle';
    let blinkProgress = 0;

    // Head movement smoothing state (autonomous idle ONLY - no cursor tracking on neck)
    let currentYaw = 0;
    let currentPitch = 0;
    let currentRoll = 0;

    // Smooth lip-sync weight
    let smoothMouth = 0;

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      const delta = clockRef.current.getDelta();
      const vrm = vrmRef.current;
      if (!vrm) {
        renderer.render(scene, camera);
        return;
      }

      time += delta;
      const em = vrm.expressionManager;
      const humanoid = vrm.humanoid;

      // ── 1. Breathing & Upper-Body Movement ────────────────────────────────
      // Organic multi-harmonic breathing wave (~0.35 Hz natural cadence)
      const breathCycle = Math.sin(time * 2.2);
      const breathHarmonic = Math.sin(time * 4.4) * 0.18;
      const breath = (breathCycle + breathHarmonic) * 0.02; // ~1.1 degrees amplitude

      if (humanoid) {
        const chest = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Chest);
        const spine = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Spine);
        const upperChest = humanoid.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
        const neck = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Neck);
        const head = humanoid.getNormalizedBoneNode(VRMHumanBoneName.Head);

        // Chest expands and gently tilts
        if (chest) {
          chest.rotation.x = breath * 0.8;
          chest.rotation.z = Math.sin(time * 0.7) * 0.006;
        }
        if (spine) {
          spine.rotation.x = breath * 0.5;
        }
        if (upperChest) {
          upperChest.rotation.x = breath * 0.6;
        }

        // ── 2. Natural Relaxed Arm Pose (No T-Pose) ──────────────────────────
        // Arms are lowered at sides and sway ever so slightly with breathing
        const leftUpperArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
        const rightUpperArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
        const leftLowerArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
        const rightLowerArm = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
        const leftHand = humanoid.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);
        const rightHand = humanoid.getNormalizedBoneNode(VRMHumanBoneName.RightHand);

        if (leftUpperArm) {
          leftUpperArm.rotation.set(
            0.08 + breath * 0.2,
            -0.05,
            -1.25 + breath * 0.12
          );
        }
        if (rightUpperArm) {
          rightUpperArm.rotation.set(
            0.08 + breath * 0.2,
            0.05,
            1.25 - breath * 0.12
          );
        }
        if (leftLowerArm) {
          leftLowerArm.rotation.set(0, -0.32, 0.05);
        }
        if (rightLowerArm) {
          rightLowerArm.rotation.set(0, 0.32, -0.05);
        }
        if (leftHand) {
          leftHand.rotation.set(-0.05, 0, -0.05);
        }
        if (rightHand) {
          rightHand.rotation.set(-0.05, 0, 0.05);
        }

        // ── 3. Gentle Autonomous Head & Neck Sway (DOES NOT follow cursor) ────
        // Per user requirement: Neck does NOT follow the cursor.
        // It maintains pure, subtle life-like autonomous breathing and micro-movement.
        const idleYaw = Math.sin(time * 0.5) * 0.035 + Math.sin(time * 0.27) * 0.015;
        const idlePitch = Math.sin(time * 0.7 + 1.0) * 0.02 + Math.sin(time * 0.35) * 0.01;
        const idleRoll = Math.sin(time * 0.45 + 2.0) * 0.012;

        let targetYaw = idleYaw;
        let targetPitch = idlePitch;
        let targetRoll = idleRoll;

        // Only explicit chat commands (e.g. "look left") alter head direction
        const lookDir = lookDirectionRef.current;
        if (lookDir === 'left') targetYaw += -0.22;
        else if (lookDir === 'right') targetYaw += 0.22;
        else if (lookDir === 'up') targetPitch += -0.15;
        else if (lookDir === 'down') targetPitch += 0.15;

        currentYaw = THREE.MathUtils.lerp(currentYaw, targetYaw, delta * 3.5);
        currentPitch = THREE.MathUtils.lerp(currentPitch, targetPitch, delta * 3.5);
        currentRoll = THREE.MathUtils.lerp(currentRoll, targetRoll, delta * 3.5);

        if (neck) {
          neck.rotation.set(currentPitch * 0.35, currentYaw * 0.35, currentRoll * 0.35);
        }
        if (head) {
          head.rotation.set(currentPitch * 0.65, currentYaw * 0.65, currentRoll * 0.65);
        }
      }

      // ── 4. Cursor Tracking: ONLY EYES Follow the Cursor ───────────────────
      // Per user requirement: ONLY eyes follow the cursor via VRMLookAt.
      if (lookAtTargetRef.current && vrm.lookAt) {
        const ptr = pointerRef.current;
        // Pointer x and y are -1 to +1 relative to container center
        // Target is placed in 3D space in front of eyes (eye level is ~y=1.52)
        const targetX = ptr.x * 1.6;
        const targetY = 1.52 + ptr.y * -0.9;
        const targetZ = 2.0;

        lookAtTargetRef.current.position.x = THREE.MathUtils.lerp(
          lookAtTargetRef.current.position.x,
          targetX,
          delta * 6.0
        );
        lookAtTargetRef.current.position.y = THREE.MathUtils.lerp(
          lookAtTargetRef.current.position.y,
          targetY,
          delta * 6.0
        );
        lookAtTargetRef.current.position.z = targetZ;

        vrm.lookAt.target = lookAtTargetRef.current;
        vrm.lookAt.autoUpdate = true;
      }

      // ── 5. Natural Periodic Blinking ──────────────────────────────────────
      blinkTimer += delta;
      if (blinkPhase === 'idle' && blinkTimer >= nextBlinkAt) {
        blinkPhase = 'closing';
        blinkProgress = 0;
      }
      if (blinkPhase === 'closing') {
        blinkProgress += delta * 14.0;
        if (blinkProgress >= 1.0) {
          blinkProgress = 1.0;
          blinkPhase = 'opening';
        }
      } else if (blinkPhase === 'opening') {
        blinkProgress -= delta * 9.0;
        if (blinkProgress <= 0.0) {
          blinkProgress = 0.0;
          blinkPhase = 'idle';
          blinkTimer = 0;
          nextBlinkAt = 2.5 + Math.random() * 3.5;
          if (Math.random() < 0.15) {
            nextBlinkAt = 0.12;
          }
        }
      }

      // ── 6. Facial Expressions & Lip Synchronization ───────────────────────
      if (em) {
        const allMorphs = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral', 'aa', 'oh'];
        allMorphs.forEach((m) => em.setValue(m, 0));

        const testExpr = activeTestExprRef.current;

        if (testExpr) {
          if (testExpr === 'blink') {
            em.setValue('blink', 1.0);
          } else {
            em.setValue(testExpr, 1.0);
            em.setValue('blink', blinkProgress);
          }
        } else {
          // Normal mode: auto expression mapping from sentiment & emotionData
          const currentExpr = expressionRef.current;
          const intensity = emotionDataRef.current?.intensity ?? 0.8;

          switch (currentExpr) {
            case 'happy_sparkle':
            case 'happy':
              em.setValue('happy', Math.min(1.0, intensity * 0.9));
              em.setValue('relaxed', intensity * 0.25);
              break;
            case 'gentle_smile':
            case 'warm':
              em.setValue('relaxed', Math.min(1.0, intensity * 0.7));
              em.setValue('happy', intensity * 0.45);
              break;
            case 'playful_smirk':
            case 'playful':
              em.setValue('happy', intensity * 0.55);
              em.setValue('surprised', intensity * 0.2);
              break;
            case 'curious_tilt':
              em.setValue('surprised', intensity * 0.45);
              em.setValue('relaxed', intensity * 0.2);
              break;
            case 'flustered_blush':
              em.setValue('surprised', intensity * 0.35);
              em.setValue('happy', intensity * 0.3);
              break;
            case 'thoughtful_gaze':
            case 'listening_attentive':
            case 'listening':
              em.setValue('neutral', intensity * 0.6);
              break;
            case 'pout_jealous':
            case 'pout':
              em.setValue('angry', intensity * 0.4);
              break;
            default:
              em.setValue('neutral', 0.4);
          }

          // Blinking
          em.setValue('blink', blinkProgress);

          // Voice Lip Sync (real audio analysis via AnalyserNode)
          const targetMouth = speakingRef.current ? Math.min(1.0, lipVolumeRef.current * 2.8) : 0;
          smoothMouth = THREE.MathUtils.lerp(smoothMouth, targetMouth, delta * 16.0);
          if (smoothMouth < 0.015) smoothMouth = 0;
          em.setValue('aa', smoothMouth);
        }
      }

      // ── 7. Update VRM (including 134 spring bones for hair physics) & Render
      vrm.update(delta);
      renderer.render(scene, camera);
    };

    clockRef.current.start();
    animate();

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();

      // Deep dispose Three.js resources
      if (vrmRef.current) {
        scene.remove(vrmRef.current.scene);
        vrmRef.current.scene.traverse((obj) => {
          if ((obj as THREE.Mesh).geometry) (obj as THREE.Mesh).geometry.dispose();
          if ((obj as THREE.Mesh).material) {
            const mats = Array.isArray((obj as THREE.Mesh).material)
              ? (obj as THREE.Mesh).material as THREE.Material[]
              : [(obj as THREE.Mesh).material as THREE.Material];
            mats.forEach((m) => {
              if ((m as any).map) (m as any).map.dispose();
              m.dispose();
            });
          }
        });
        vrmRef.current = null;
      }

      if (lookAtTargetRef.current) {
        scene.remove(lookAtTargetRef.current);
        lookAtTargetRef.current = null;
      }

      renderer.dispose();
      renderer.forceContextLoss();
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative select-none"
      style={{ minHeight: '400px' }}
    >
      {/* Loading overlay */}
      {!isLoaded && !loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-20 pointer-events-none">
          <div className="w-10 h-10 border-2 border-cyan-400/30 border-t-cyan-400 rounded-full animate-spin mb-3 shadow-[0_0_15px_rgba(6,182,212,0.4)]" />
          <p className="text-xs text-cyan-300 font-medium tracking-wide">
            Loading Krix 3D Avatar{loadProgress > 0 ? ` (${loadProgress}%)` : '…'}
          </p>
        </div>
      )}

      {/* Error fallback */}
      {loadError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center z-20 pointer-events-none px-6">
          <p className="text-xs text-red-400 text-center max-w-xs font-medium">
            ⚠ {loadError}
          </p>
          <p className="text-[10px] text-slate-400 mt-2">
            The 2D avatar remains active as a fallback.
          </p>
        </div>
      )}

      {/* ── Interactive Expression Reviewer Tray ───────────────────────────── */}
      {isLoaded && (
        <div className="absolute top-3 right-3 z-40 flex flex-col items-end pointer-events-auto">
          <button
            type="button"
            onClick={() => setShowExpressionTester((prev) => !prev)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-medium tracking-wider uppercase backdrop-blur-md border border-cyan-500/30 bg-[#0b1329]/80 text-cyan-300 hover:text-white hover:border-cyan-400/60 shadow-[0_0_12px_rgba(6,182,212,0.2)] transition-all cursor-pointer"
            title="Toggle Expression Review Tray"
          >
            <span>🎭 Expressions</span>
            {activeTestExpression && (
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            )}
          </button>

          {showExpressionTester && (
            <div className="mt-2 p-2.5 rounded-2xl backdrop-blur-xl border border-cyan-500/25 bg-[#070e22]/90 shadow-[0_12px_32px_rgba(0,0,0,0.65)] flex flex-col gap-2 max-w-[220px]">
              <div className="flex items-center justify-between text-[10px] text-slate-300 font-medium border-b border-white/10 pb-1.5">
                <span>Model Expressions:</span>
                <span className="text-cyan-400 font-mono text-[9px]">VRM 1.0</span>
              </div>

              <div className="flex flex-wrap gap-1">
                {/* Auto / Sentiment Button */}
                <button
                  type="button"
                  onClick={() => setActiveTestExpression(null)}
                  className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                    activeTestExpression === null
                      ? 'bg-cyan-500/30 text-cyan-200 border border-cyan-400/50 shadow-[0_0_10px_rgba(6,182,212,0.3)]'
                      : 'bg-white/5 text-slate-400 hover:text-slate-200 border border-transparent'
                  }`}
                  title="Follow chat sentiment & voice"
                >
                  ⚡ Auto
                </button>

                {/* Individual verified expression presets */}
                {[
                  { id: 'happy', label: 'Happy 😊' },
                  { id: 'relaxed', label: 'Relaxed 😌' },
                  { id: 'surprised', label: 'Surprised 😮' },
                  { id: 'sad', label: 'Sad 🥺' },
                  { id: 'angry', label: 'Angry 😠' },
                  { id: 'neutral', label: 'Neutral 😐' },
                  { id: 'aa', label: 'Mouth Open 🗣️' },
                  { id: 'oh', label: 'Oh 😲' },
                  { id: 'blink', label: 'Blink 😉' },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTestExpression(item.id)}
                    className={`px-2 py-1 rounded-lg text-[10px] font-medium transition-all cursor-pointer ${
                      activeTestExpression === item.id
                        ? 'bg-emerald-500/30 text-emerald-200 border border-emerald-400/50 shadow-[0_0_10px_rgba(16,185,129,0.3)]'
                        : 'bg-white/5 text-slate-400 hover:text-slate-200 border border-transparent'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default KrixAvatar;
