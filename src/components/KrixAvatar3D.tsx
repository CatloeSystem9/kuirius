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

// ── Emote IDs (All Supported Procedural Gestures) ──────────────────────────────
export type EmoteId =
  // Step 2 (Basic)
  | 'wave'
  | 'bow'
  | 'dance'
  | 'nod'
  | 'shake_head'
  | 'point'
  // Step 3 (Emotional Gestures)
  | 'laugh'
  | 'sad'
  | 'angry'
  | 'surprised'
  | 'thinking'
  // Step 4 (Complex Movements)
  | 'clap'
  | 'shrug'
  | 'facepalm'
  // Step 5 (Expansion)
  | 'thumbs_up'
  | 'excited'
  | 'curious_tilt'
  | 'gentle_greeting'
  | 'shy'
  | 'attentive_listening';

// ── Finger articulation (used by thumbs_up; right hand, verified node names) ──
export interface FingerPose {
  rIndex1: THREE.Euler;
  rIndex2: THREE.Euler;
  rMiddle1: THREE.Euler;
  rMiddle2: THREE.Euler;
  rRing1: THREE.Euler;
  rRing2: THREE.Euler;
  rLittle1: THREE.Euler;
  rLittle2: THREE.Euler;
}
type FingerOverride = Partial<FingerPose>;

// ── Emote state machine ────────────────────────────────────────────────────────
/** Where a gesture came from. The response-lifecycle thinking hold may preempt
 *  'emotion' gestures, but never 'command' (greeting/thanks), 'console' (tests)
 *  or 'dance' gestures. */
export type EmoteSource = 'command' | 'emotion' | 'console' | 'lifecycle';

interface EmoteState {
  id: EmoteId;
  elapsed: number;
  duration: number;
  blendIn: number;
  blendOut: number;
  loop: boolean;
  blendWeight: number;
  source: EmoteSource;
  /** Bone rotations captured when this emote interrupted another, used to cross-fade in smoothly. */
  snapshot: BoneOverride | null;
}

// ── Resting pose for each bone we control in emotes ───────────────────────────
interface RestPose {
  rightUpperArm: THREE.Euler;
  rightLowerArm: THREE.Euler;
  rightHand: THREE.Euler;
  leftUpperArm: THREE.Euler;
  leftLowerArm: THREE.Euler;
  leftHand: THREE.Euler;
  leftShoulder: THREE.Euler;
  rightShoulder: THREE.Euler;
  spine: THREE.Euler;
  chest: THREE.Euler;
  upperChest: THREE.Euler;
  neck: THREE.Euler;
  head: THREE.Euler;
}

type BoneOverride = Partial<Record<keyof RestPose, THREE.Euler>> & { fingers?: FingerOverride };

// Finger bones controllable by emotes (verified normalized node naming, curl
// axes measured by FK: joint1 ≈ (0, −1.2·m, 0.6·m), joint2 ×0.85 folds a fist).
const FINGER_BONES: Array<[keyof FingerPose, VRMHumanBoneName]> = [
  ['rIndex1',  VRMHumanBoneName.RightIndexProximal],
  ['rIndex2',  VRMHumanBoneName.RightIndexIntermediate],
  ['rMiddle1', VRMHumanBoneName.RightMiddleProximal],
  ['rMiddle2', VRMHumanBoneName.RightMiddleIntermediate],
  ['rRing1',   VRMHumanBoneName.RightRingProximal],
  ['rRing2',   VRMHumanBoneName.RightRingIntermediate],
  ['rLittle1', VRMHumanBoneName.RightLittleProximal],
  ['rLittle2', VRMHumanBoneName.RightLittleIntermediate],
];
const FINGER_REST = (): FingerOverride => ({
  rIndex1: new THREE.Euler(0, 0, 0), rIndex2: new THREE.Euler(0, 0, 0),
  rMiddle1: new THREE.Euler(0, 0, 0), rMiddle2: new THREE.Euler(0, 0, 0),
  rRing1: new THREE.Euler(0, 0, 0), rRing2: new THREE.Euler(0, 0, 0),
  rLittle1: new THREE.Euler(0, 0, 0), rLittle2: new THREE.Euler(0, 0, 0),
});
const FIST_CURL = (m: number): FingerOverride => ({
  rIndex1: new THREE.Euler(0, -1.2 * m, 0.6 * m),
  rIndex2: new THREE.Euler(0, -1.02 * m, 0.51 * m),
  rMiddle1: new THREE.Euler(0, -1.2 * m, 0.6 * m),
  rMiddle2: new THREE.Euler(0, -1.02 * m, 0.51 * m),
  rRing1: new THREE.Euler(0, -1.2 * m, 0.6 * m),
  rRing2: new THREE.Euler(0, -1.02 * m, 0.51 * m),
  rLittle1: new THREE.Euler(0, -1.2 * m, 0.6 * m),
  rLittle2: new THREE.Euler(0, -1.02 * m, 0.51 * m),
});

// Bones controllable by emotes — also used to snapshot the live pose when a
// gesture interrupts another, and by the __krixGetBoneRotations test hook.
const EMOTE_BONES: Array<[keyof RestPose, VRMHumanBoneName]> = [
  ['rightUpperArm', VRMHumanBoneName.RightUpperArm],
  ['rightLowerArm', VRMHumanBoneName.RightLowerArm],
  ['rightHand',     VRMHumanBoneName.RightHand],
  ['leftUpperArm',  VRMHumanBoneName.LeftUpperArm],
  ['leftLowerArm',  VRMHumanBoneName.LeftLowerArm],
  ['leftHand',      VRMHumanBoneName.LeftHand],
  ['leftShoulder',  VRMHumanBoneName.LeftShoulder],
  ['rightShoulder', VRMHumanBoneName.RightShoulder],
  ['spine',         VRMHumanBoneName.Spine],
  ['chest',         VRMHumanBoneName.Chest],
  ['upperChest',    VRMHumanBoneName.UpperChest],
  ['neck',          VRMHumanBoneName.Neck],
  ['head',          VRMHumanBoneName.Head],
];

// Easing helpers
function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// ── Component props ────────────────────────────────────────────────────────────
export interface KrixAvatarProps {
  expression?: AvatarExpression;
  emotionData?: EmotionAnalysis;
  isSpeaking: boolean;
  isListening?: boolean;
  /** Ambient voice-listening state (App: wakeWordStatus 'listening'/'detected'). */
  isVoiceListening?: boolean;
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
  isVoiceListening = false,
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

  // Expression review state
  const [activeTestExpression, setActiveTestExpression] = useState<string | null>(null);
  const [showExpressionTester, setShowExpressionTester] = useState(false);
  const activeTestExprRef = useRef<string | null>(null);
  useEffect(() => { activeTestExprRef.current = activeTestExpression; }, [activeTestExpression]);

  // Keep latest props in refs for animation loop (avoid React re-renders every frame)
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

  const isDancingRef = useRef(isDancing);
  useEffect(() => { isDancingRef.current = isDancing; }, [isDancing]);

  const isGreetingRef = useRef(isGreeting);
  useEffect(() => { isGreetingRef.current = isGreeting; }, [isGreeting]);

  const isThankedRef = useRef(isThanked);
  useEffect(() => { isThankedRef.current = isThanked; }, [isThanked]);

  const isListeningRef = useRef(isListening);
  useEffect(() => { isListeningRef.current = isListening; }, [isListening]);

  const isVoiceListeningRef = useRef(isVoiceListening);
  useEffect(() => { isVoiceListeningRef.current = isVoiceListening; }, [isVoiceListening]);

  // External emote trigger reference for test suite / console access
  const triggerEmoteRef = useRef<(id: EmoteId) => void>(() => {});
  // Mirrors the engine's active emote id for diagnostics/test hooks.
  const activeEmoteIdRef = useRef<EmoteId | null>(null);

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
    (window as any).__krixPlayEmote = (emoteId: EmoteId) => {
      triggerEmoteRef.current(emoteId);
    };
    (window as any).__krixGetEmotes = () => [
      'wave', 'bow', 'dance', 'nod', 'shake_head', 'point',
      'laugh', 'sad', 'angry', 'surprised', 'thinking',
      'clap', 'shrug', 'facepalm',
      'thumbs_up', 'excited', 'curious_tilt', 'gentle_greeting', 'shy', 'attentive_listening'
    ];
    (window as any).__krixGetBoneRotations = () => {
      const vrm = vrmRef.current;
      if (!vrm?.humanoid) return null;
      const out: Record<string, number[]> = {};
      for (const [key, name] of EMOTE_BONES) {
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        if (node) out[key] = [node.rotation.x, node.rotation.y, node.rotation.z];
      }
      for (const [key, name] of FINGER_BONES) {
        const node = vrm.humanoid.getNormalizedBoneNode(name);
        if (node) out[key] = [node.rotation.x, node.rotation.y, node.rotation.z];
      }
      return out;
    };
    // Diagnostic: world-space positions of the normalized bones (and the head
    // joint) so automated tests can verify actual visible hand/arm placement.
    (window as any).__krixGetBoneWorldPositions = () => {
      const vrm = vrmRef.current;
      if (!vrm?.humanoid) return null;
      const out: Record<string, { pos: number[]; child: number[] | null }> = {};
      const readNode = (key: string, node: THREE.Object3D | null) => {
        if (!node) return;
        node.updateWorldMatrix(true, false);
        const p = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
        const child = node.children[0];
        let cp: number[] | null = null;
        if (child) {
          child.updateWorldMatrix(true, false);
          cp = new THREE.Vector3().setFromMatrixPosition(child.matrixWorld).toArray();
        }
        out[key] = { pos: p.toArray(), child: cp };
      };
      for (const [key, name] of EMOTE_BONES) {
        readNode(key, vrm.humanoid.getNormalizedBoneNode(name));
      }
      for (const [key, name] of FINGER_BONES) {
        readNode(key, vrm.humanoid.getNormalizedBoneNode(name));
      }
      return out;
    };
    // Diagnostic: an offline clone of the normalized rig for forward-kinematics
    // solvers (pose search) without disturbing the live animation loop.
    (window as any).__krixGetNormalizedRigClone = () => {
      const vrm = vrmRef.current;
      if (!vrm?.humanoid) return null;
      return vrm.humanoid.normalizedHumanBonesRoot.clone(true);
    };
    // Test hook: drive the isDancing lifecycle signal the same way the App prop
    // does, so automated tests can verify dance start/stop/restore end-to-end.
    (window as any).__krixSetDancing = (v: boolean) => { isDancingRef.current = v; };
    // Test hook: drive the ambient voice-listening lifecycle signal the same way
    // the App prop does (attentive listening verification).
    (window as any).__krixSetVoiceListening = (v: boolean) => { isVoiceListeningRef.current = v; };
    // Test hook: drive the response-preparation lifecycle signal the same way the
    // App prop does (thinking-hold priority verification).
    (window as any).__krixSetPreparing = (v: boolean) => { isListeningRef.current = v; };
    // Diagnostic: the lifecycle signals the animation loop currently sees.
    (window as any).__krixGetLifecycleSignals = () => ({
      isListening: isListeningRef.current,
      isSpeaking: speakingRef.current,
      isDancing: isDancingRef.current,
      isVoiceListening: isVoiceListeningRef.current,
      activeEmoteId: activeEmoteIdRef.current,
    });
    return () => {
      delete (window as any).__krixSetExpression;
      delete (window as any).__krixGetExpressions;
      delete (window as any).__krixIsLoaded;
      delete (window as any).__krixPlayEmote;
      delete (window as any).__krixGetEmotes;
      delete (window as any).__krixGetBoneRotations;
      delete (window as any).__krixGetBoneWorldPositions;
      delete (window as any).__krixGetNormalizedRigClone;
      delete (window as any).__krixSetDancing;
      delete (window as any).__krixSetVoiceListening;
      delete (window as any).__krixSetPreparing;
      delete (window as any).__krixGetLifecycleSignals;
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

    // 2. Camera: Full body framing (height 1.72m, centered y≈0.86m)
    const initialWidth = container.clientWidth || 400;
    const initialHeight = container.clientHeight || 580;
    const camera = new THREE.PerspectiveCamera(28, initialWidth / initialHeight, 0.1, 50);
    camera.position.set(0, 0.88, 3.85);
    camera.lookAt(0, 0.86, 0);
    cameraRef.current = camera;

    // 3. Renderer — transparent background, clamped pixel ratio
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

    // 4. Lighting — dark-navy/electric-blue palette
    const ambientLight = new THREE.AmbientLight(0xc8d8f8, 1.0);
    scene.add(ambientLight);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.5);
    keyLight.position.set(0.8, 2.2, 2.5);
    scene.add(keyLight);
    const cyanFillLight = new THREE.DirectionalLight(0x38bdf8, 0.85);
    cyanFillLight.position.set(-1.6, 1.4, 2.2);
    scene.add(cyanFillLight);
    const lowerFillLight = new THREE.DirectionalLight(0x88b0f8, 0.5);
    lowerFillLight.position.set(0, 0.4, 2.0);
    scene.add(lowerFillLight);
    const rimLight = new THREE.DirectionalLight(0x00d4ff, 0.85);
    rimLight.position.set(0, 1.8, -2.0);
    scene.add(rimLight);

    // 5. LookAt target — only eyes track cursor, not neck
    const lookAtTarget = new THREE.Object3D();
    lookAtTarget.position.set(0, 1.52, 2.0);
    scene.add(lookAtTarget);
    lookAtTargetRef.current = lookAtTarget;

    // 6. Load VRM
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

        // VRM 1.0 faces +Z directly facing our camera
        VRMUtils.rotateVRM0(vrm);
        vrm.scene.rotation.y = 0;
        scene.add(vrm.scene);
        vrmRef.current = vrm;

        if (vrm.lookAt) {
          vrm.lookAt.target = lookAtTarget;
          vrm.lookAt.autoUpdate = true;
        }

        // Set initial relaxed standing pose
        const h = vrm.humanoid;
        if (h) {
          const lUA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
          const rUA = h.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
          const lLA = h.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
          const rLA = h.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
          const lH  = h.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);
          const rH  = h.getNormalizedBoneNode(VRMHumanBoneName.RightHand);
          if (lUA) lUA.rotation.set(0.08, -0.05, -1.25);
          if (rUA) rUA.rotation.set(0.08, 0.05, 1.25);
          if (lLA) lLA.rotation.set(0, -0.32, 0.05);
          if (rLA) rLA.rotation.set(0, 0.32, -0.05);
          if (lH)  lH.rotation.set(-0.05, 0, -0.05);
          if (rH)  rH.rotation.set(-0.05, 0, 0.05);
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

    // 7. Responsive resize
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

    // ══════════════════════════════════════════════════════════════════════════
    // ANIMATION LOOP & PROCEDURAL ENGINE
    // ══════════════════════════════════════════════════════════════════════════
    let time = 0;

    // ── Idle state ───────────────────────────────────────────────────────────
    let blinkTimer = 0;
    let nextBlinkAt = 2.5 + Math.random() * 3.5;
    let blinkPhase: 'idle' | 'closing' | 'opening' = 'idle';
    let blinkProgress = 0;
    let currentYaw = 0;
    let currentPitch = 0;
    let currentRoll = 0;
    let smoothMouth = 0;

    // ── Resting baseline for all controlled bones ─────────────────────────────
    const REST: RestPose = {
      rightUpperArm: new THREE.Euler(0.08, 0.05, 1.25),
      rightLowerArm: new THREE.Euler(0, 0.32, -0.05),
      rightHand:     new THREE.Euler(-0.05, 0, 0.05),
      leftUpperArm:  new THREE.Euler(0.08, -0.05, -1.25),
      leftLowerArm:  new THREE.Euler(0, -0.32, 0.05),
      leftHand:      new THREE.Euler(-0.05, 0, -0.05),
      leftShoulder:  new THREE.Euler(0, 0, 0),
      rightShoulder: new THREE.Euler(0, 0, 0),
      spine:         new THREE.Euler(0, 0, 0),
      chest:         new THREE.Euler(0, 0, 0),
      upperChest:    new THREE.Euler(0, 0, 0),
      neck:          new THREE.Euler(0, 0, 0),
      head:          new THREE.Euler(0, 0, 0),
    };

    // ── Emote definitions: procedural bone calculation per emote ─────────────

    // Step 2.1 — Wave
    // Pose values SOLVED against the actual model rig by world-space FK: the hand
    // ends up beside the head (wrist ≈ (−0.17, 1.52, 0.04) vs head joint y 1.497),
    // with the elbow out and the forearm folded up. The visible side-to-side wave
    // is a ±0.20 rad Z oscillation of the forearm (±7 cm hand sweep, measured),
    // plus a gentle palm twist. Torso, head and left arm untouched.
    function emoteWave(t: number, globalTime: number): BoneOverride {
      const raise = easeInOut(clamp01(t * 2.8));
      const wave = Math.sin(globalTime * 6.3) * 0.20 * raise;
      const armX = THREE.MathUtils.lerp(REST.rightUpperArm.x, -0.40, raise);
      const armY = THREE.MathUtils.lerp(REST.rightUpperArm.y, 0.45, raise);
      const armZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, 0.36, raise);
      const elbX = THREE.MathUtils.lerp(REST.rightLowerArm.x, -0.45, raise);
      const elbY = THREE.MathUtils.lerp(REST.rightLowerArm.y, 2.45, raise);
      const elbZ = THREE.MathUtils.lerp(REST.rightLowerArm.z, -0.50, raise);
      return {
        rightUpperArm: new THREE.Euler(armX, armY, armZ),
        rightLowerArm: new THREE.Euler(elbX, elbY, elbZ + wave),
        rightHand:     new THREE.Euler(REST.rightHand.x + Math.sin(globalTime * 6.3 + 0.6) * 0.12 * raise, REST.rightHand.y, REST.rightHand.z),
      };
    }

    // Step 2.2 — Bow
    // Controlled upper-body bend that eases in and HOLDS; the blend-out performs
    // the smooth return. The head follows the torso with a slight extra down-tilt.
    // Arms and shoulders untouched.
    function emoteBow(t: number, _globalTime: number): BoneOverride {
      const bowCurve = easeInOut(clamp01(t / 0.35));
      const bendX = bowCurve * 0.52;
      return {
        spine:      new THREE.Euler(bendX * 0.40, 0, 0),
        chest:      new THREE.Euler(bendX * 0.35, 0, 0),
        upperChest: new THREE.Euler(bendX * 0.25, 0, 0),
        head:       new THREE.Euler(bendX * 0.12, 0, 0),
      };
    }

    // Step 4.2 — Dance
    // The ONLY looping gesture, kept restrained: gentle weight shift, soft
    // alternating arm swing (Y-flexion, not X-twist) and a small beat lift.
    function emoteDance(_t: number, globalTime: number): BoneOverride {
      const beat = globalTime * 3.0;
      const sway = Math.sin(beat) * 0.05;
      const bounce = Math.abs(Math.sin(beat)) * 0.02;
      const bob = Math.sin(beat * 2.0) * 0.028;
      const swing = Math.sin(beat);
      const lift = Math.abs(Math.sin(beat));

      return {
        spine:        new THREE.Euler(0.012 + bounce * 0.3, sway * 0.5, sway * 0.22),
        chest:        new THREE.Euler(bounce * 0.6, sway * 0.4, -sway * 0.18),
        upperChest:   new THREE.Euler(0, sway * 0.3, -sway * 0.12),
        neck:         new THREE.Euler(bob * 0.35, -sway * 0.3, 0),
        head:         new THREE.Euler(bob * 0.55, -sway * 0.4, 0),
        leftShoulder: new THREE.Euler(0, 0, 0.03 * lift),
        rightShoulder:new THREE.Euler(0, 0, -0.03 * lift),
        rightUpperArm:new THREE.Euler(0, 0.10 + swing * 0.14, 1.04 - lift * 0.20),
        leftUpperArm: new THREE.Euler(0, -0.10 + swing * 0.14, -1.04 + lift * 0.20),
        rightLowerArm:new THREE.Euler(0, 0.55 + swing * 0.08, REST.rightLowerArm.z),
        leftLowerArm: new THREE.Euler(0, -0.55 + swing * 0.08, REST.leftLowerArm.z),
        rightHand:    new THREE.Euler(REST.rightHand.x, 0, 0.08),
        leftHand:     new THREE.Euler(REST.leftHand.x, 0, -0.08),
      };
    }

    // Step 2.4 — Nod
    // Head/neck only; one to two damped downward nods. Nothing else moves.
    function emoteNod(_t: number, globalTime: number): BoneOverride {
      const nod = Math.sin(globalTime * 7.0) * Math.exp(-globalTime * 2.0) * 0.16;
      return {
        neck: new THREE.Euler(nod * 0.35, 0, 0),
        head: new THREE.Euler(nod * 0.65, 0, 0),
      };
    }

    // Step 2.5 — Shake Head
    // Head/neck yaw only; damped side-to-side. Torso and arms untouched.
    function emoteShakeHead(_t: number, globalTime: number): BoneOverride {
      const shake = Math.sin(globalTime * 7.5) * Math.exp(-globalTime * 1.8) * 0.16;
      return {
        neck: new THREE.Euler(0, shake * 0.35, 0),
        head: new THREE.Euler(0, shake * 0.65, 0),
      };
    }

    // Step 2.6 — Point
    // Right arm extends forward (Y-flexion swings the lowered arm forward) to a
    // clearly readable forward-right diagonal. Torso, head and left arm untouched.
    function emotePoint(t: number, _globalTime: number): BoneOverride {
      const raise = easeInOut(clamp01(t * 2.5));
      const armY = THREE.MathUtils.lerp(REST.rightUpperArm.y, 1.05, raise);
      const armZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, 0.30, raise);
      return {
        rightUpperArm: new THREE.Euler(0, armY, armZ),
        rightLowerArm: new THREE.Euler(0, THREE.MathUtils.lerp(REST.rightLowerArm.y, 0.10, raise), REST.rightLowerArm.z),
        rightHand:     new THREE.Euler(REST.rightHand.x, REST.rightHand.y, REST.rightHand.z),
      };
    }

    // Step 3.1 — Laugh
    // A restrained chuckle: a couple of small chest/shoulder bounces that settle,
    // plus a slight head back-tilt. No whole-body movement.
    function emoteLaugh(t: number, globalTime: number): BoneOverride {
      const decay = Math.exp(-t * 2.4);
      const chuckle = Math.sin(globalTime * 11.0) * decay * 0.026;
      const headBob = Math.sin(globalTime * 11.0 + 0.7) * decay * 0.02;
      return {
        head:         new THREE.Euler(-0.06 + headBob, 0, 0),
        neck:         new THREE.Euler(-0.03 + headBob * 0.5, 0, 0),
        chest:        new THREE.Euler(0.02 + chuckle, 0, chuckle * 0.3),
        spine:        new THREE.Euler(0.01 + chuckle * 0.4, 0, 0),
        leftShoulder: new THREE.Euler(0, 0, Math.abs(chuckle) * 0.55),
        rightShoulder:new THREE.Euler(0, 0, -Math.abs(chuckle) * 0.55),
      };
    }

    // Step 3.2 — Sad
    // Slow head drop and slight posture slump, easing in and holding (the blend-out
    // returns to neutral). Shoulders droop; arms tuck marginally closer to the body.
    function emoteSad(t: number, _globalTime: number): BoneOverride {
      const dip = easeInOut(clamp01(t / 0.55));
      return {
        head:         new THREE.Euler(0.17 * dip, 0, 0),
        neck:         new THREE.Euler(0.07 * dip, 0, 0),
        spine:        new THREE.Euler(0.055 * dip, 0, 0),
        chest:        new THREE.Euler(0.045 * dip, 0, 0),
        upperChest:   new THREE.Euler(0.03 * dip, 0, 0),
        leftShoulder: new THREE.Euler(0, 0, -0.05 * dip),
        rightShoulder:new THREE.Euler(0, 0, 0.05 * dip),
        leftUpperArm: new THREE.Euler(REST.leftUpperArm.x, REST.leftUpperArm.y, REST.leftUpperArm.z - 0.05 * dip),
        rightUpperArm:new THREE.Euler(REST.rightUpperArm.x, REST.rightUpperArm.y, REST.rightUpperArm.z + 0.05 * dip),
      };
    }

    // Step 3.3 — Angry
    // A held tension pose: slight forward lean of the head, chest up, arms drawn in.
    // Fully static — no oscillation.
    function emoteAngry(_t: number, _globalTime: number): BoneOverride {
      return {
        head:         new THREE.Euler(0.05, 0.07, 0),
        neck:         new THREE.Euler(0.03, 0.04, 0),
        spine:        new THREE.Euler(-0.02, 0, 0),
        chest:        new THREE.Euler(-0.03, 0, 0),
        upperChest:   new THREE.Euler(-0.02, 0, 0),
        rightUpperArm:new THREE.Euler(0, 0.10, 1.32),
        leftUpperArm: new THREE.Euler(0, -0.10, -1.32),
        rightLowerArm:new THREE.Euler(0, 0.42, REST.rightLowerArm.z),
        leftLowerArm: new THREE.Euler(0, -0.42, REST.leftLowerArm.z),
      };
    }

    // Step 3.4 — Surprised
    // Small, brief startle: quick pop upward/back, tiny arm flare, smooth return.
    function emoteSurprised(t: number, _globalTime: number): BoneOverride {
      const pop = t < 0.2 ? easeInOut(t / 0.2) : easeInOut(clamp01((1.0 - t) / 0.8));
      return {
        head:         new THREE.Euler(-0.11 * pop, 0, 0),
        neck:         new THREE.Euler(-0.05 * pop, 0, 0),
        chest:        new THREE.Euler(-0.045 * pop, 0, 0),
        upperChest:   new THREE.Euler(-0.035 * pop, 0, 0),
        rightUpperArm:new THREE.Euler(REST.rightUpperArm.x, REST.rightUpperArm.y, REST.rightUpperArm.z - 0.07 * pop),
        leftUpperArm: new THREE.Euler(REST.leftUpperArm.x, REST.leftUpperArm.y, REST.leftUpperArm.z + 0.07 * pop),
        rightShoulder:new THREE.Euler(0, 0, -0.04 * pop),
        leftShoulder: new THREE.Euler(0, 0, 0.04 * pop),
      };
    }

    // Step 3.5 — Thinking
    // Pose values SOLVED by world-space FK: the hand reaches the chin
    // (wrist ≈ (0.01, 1.41, 0.09); chin ≈ (0, 1.40, 0.07)) — upper arm swung
    // forward, forearm strongly folded back. Slight head tilt; static hold.
    function emoteThinking(t: number, _globalTime: number): BoneOverride {
      // Entry completes at holdT ≈ 0.33 so the pose is fully formed before any
      // plausible response-lifecycle exit (prevents partial-pose pops).
      const raise = easeInOut(clamp01(t * 3.0));
      const armX = THREE.MathUtils.lerp(REST.rightUpperArm.x, -0.05, raise);
      const armY = THREE.MathUtils.lerp(REST.rightUpperArm.y, 1.20, raise);
      const armZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, -0.24, raise);
      const elbX = THREE.MathUtils.lerp(REST.rightLowerArm.x, -0.25, raise);
      const elbY = THREE.MathUtils.lerp(REST.rightLowerArm.y, 2.42, raise);
      const elbZ = THREE.MathUtils.lerp(REST.rightLowerArm.z, 0.18, raise);
      return {
        head:         new THREE.Euler(0.05, -0.15, 0.09),
        neck:         new THREE.Euler(0.03, -0.07, 0.05),
        spine:        new THREE.Euler(0.015, -0.02, 0),
        rightUpperArm:new THREE.Euler(armX, armY, armZ),
        rightLowerArm:new THREE.Euler(elbX, elbY, elbZ),
        rightHand:    new THREE.Euler(THREE.MathUtils.lerp(REST.rightHand.x, 0, raise), REST.rightHand.y, REST.rightHand.z),
      };
    }

    // Step 4.1 — Clap
    // Pose values SOLVED by world-space FK: both forearms fold in front of the
    // chest with the wrists 10 cm apart (gap CLOSED, measured) and 21 cm apart
    // (gap OPEN) — the hands genuinely approach each other instead of only the
    // sleeves. The open/close cycles through elbow flexion. Torso stays stable.
    function emoteClap(t: number, globalTime: number): BoneOverride {
      const raise = easeInOut(clamp01(t * 2.6));
      const open = (0.5 - 0.5 * Math.cos(globalTime * 10.5)) * raise;

      const rArmX = THREE.MathUtils.lerp(REST.rightUpperArm.x, -0.079, raise);
      const rArmY = THREE.MathUtils.lerp(REST.rightUpperArm.y, 0.19, raise);
      const rArmZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, 1.20, raise);
      const rElbX = THREE.MathUtils.lerp(REST.rightLowerArm.x, 0.392, raise);
      const rElbY = THREE.MathUtils.lerp(REST.rightLowerArm.y, 1.715 - 0.615 * open, raise);
      const lArmX = THREE.MathUtils.lerp(REST.leftUpperArm.x, -0.079, raise);
      const lArmY = THREE.MathUtils.lerp(REST.leftUpperArm.y, -0.19, raise);
      const lArmZ = THREE.MathUtils.lerp(REST.leftUpperArm.z, -1.20, raise);
      const lElbX = THREE.MathUtils.lerp(REST.leftLowerArm.x, 0.392, raise);
      const lElbY = THREE.MathUtils.lerp(REST.leftLowerArm.y, -1.715 + 0.615 * open, raise);

      return {
        rightUpperArm:new THREE.Euler(rArmX, rArmY, rArmZ),
        leftUpperArm: new THREE.Euler(lArmX, lArmY, lArmZ),
        rightLowerArm:new THREE.Euler(rElbX, rElbY, REST.rightLowerArm.z),
        leftLowerArm: new THREE.Euler(lElbX, lElbY, REST.leftLowerArm.z),
        rightHand:    new THREE.Euler(0, 0.12, REST.rightHand.z),
        leftHand:     new THREE.Euler(0, -0.12, REST.leftHand.z),
      };
    }

    // Step 4.3 — Shrug
    // Shoulders lift, arms open slightly with forearms relaxed outward, brief head
    // tilt; the pose is HELD and the blend-out returns to neutral. No oscillation.
    function emoteShrug(t: number, _globalTime: number): BoneOverride {
      const c = easeInOut(clamp01(t * 2.2));

      return {
        head:         new THREE.Euler(0.02 * c, 0.05 * c, 0.07 * c),
        neck:         new THREE.Euler(0.01 * c, 0.02 * c, 0.04 * c),
        leftShoulder: new THREE.Euler(0, 0, 0.17 * c),
        rightShoulder:new THREE.Euler(0, 0, -0.17 * c),
        rightUpperArm:new THREE.Euler(REST.rightUpperArm.x, THREE.MathUtils.lerp(REST.rightUpperArm.y, 0.12, c), THREE.MathUtils.lerp(REST.rightUpperArm.z, 1.02, c)),
        leftUpperArm: new THREE.Euler(REST.leftUpperArm.x, THREE.MathUtils.lerp(REST.leftUpperArm.y, -0.12, c), THREE.MathUtils.lerp(REST.leftUpperArm.z, -1.02, c)),
        rightLowerArm:new THREE.Euler(0, THREE.MathUtils.lerp(REST.rightLowerArm.y, 0.75, c), THREE.MathUtils.lerp(REST.rightLowerArm.z, -0.12, c)),
        leftLowerArm: new THREE.Euler(0, THREE.MathUtils.lerp(REST.leftLowerArm.y, -0.75, c), THREE.MathUtils.lerp(REST.leftLowerArm.z, 0.12, c)),
        rightHand:    new THREE.Euler(THREE.MathUtils.lerp(REST.rightHand.x, -0.25, c), THREE.MathUtils.lerp(REST.rightHand.y, 0.10, c), THREE.MathUtils.lerp(REST.rightHand.z, 0.12, c)),
        leftHand:     new THREE.Euler(THREE.MathUtils.lerp(REST.leftHand.x, -0.25, c), THREE.MathUtils.lerp(REST.leftHand.y, -0.10, c), THREE.MathUtils.lerp(REST.leftHand.z, -0.12, c)),
      };
    }

    // Step 4.4 — Facepalm
    // Pose values SOLVED by world-space FK: the hand reaches the forehead
    // (wrist ≈ (0.00, 1.53, 0.10); forehead ≈ (0, 1.54, 0.06)). Head drops
    // slightly; held, then released by the blend-out.
    function emoteFacepalm(t: number, _globalTime: number): BoneOverride {
      const raise = easeInOut(clamp01(t * 2.4));
      const armX = THREE.MathUtils.lerp(REST.rightUpperArm.x, -0.60, raise);
      const armY = THREE.MathUtils.lerp(REST.rightUpperArm.y, 1.15, raise);
      const armZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, 0.20, raise);
      const elbX = THREE.MathUtils.lerp(REST.rightLowerArm.x, -0.45, raise);
      const elbY = THREE.MathUtils.lerp(REST.rightLowerArm.y, 2.10, raise);
      const elbZ = THREE.MathUtils.lerp(REST.rightLowerArm.z, 0, raise);

      return {
        head:         new THREE.Euler(0.13 * raise, -0.04 * raise, 0.04 * raise),
        neck:         new THREE.Euler(0.06 * raise, -0.02 * raise, 0.02 * raise),
        spine:        new THREE.Euler(0.03 * raise, 0, 0),
        rightUpperArm:new THREE.Euler(armX, armY, armZ),
        rightLowerArm:new THREE.Euler(elbX, elbY, elbZ),
        rightHand:    new THREE.Euler(THREE.MathUtils.lerp(REST.rightHand.x, 0, raise), REST.rightHand.y, REST.rightHand.z),
      };
    }

    // Step 5.1 — Thumbs Up
    // Pose values SOLVED by world-space FK: wrist at (−0.23, 1.12, 0.16)
    // (chest-side height, slightly forward), hand rotated so the thumb tip sits
    // 8.3 cm ABOVE the wrist, and the four fingers fold into a fist using the
    // model's actual finger bones (curl measured: fingertips move ≈5 cm toward
    // the palm). The thumb itself stays extended at its rest chain.
    function emoteThumbsUp(t: number, _globalTime: number): BoneOverride {
      const raise = easeInOut(clamp01(t * 2.6));
      const armX = THREE.MathUtils.lerp(REST.rightUpperArm.x, -0.037, raise);
      const armY = THREE.MathUtils.lerp(REST.rightUpperArm.y, -0.024, raise);
      const armZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, 1.27, raise);
      const elbX = THREE.MathUtils.lerp(REST.rightLowerArm.x, -0.167, raise);
      const elbY = THREE.MathUtils.lerp(REST.rightLowerArm.y, 1.096, raise);
      const elbZ = THREE.MathUtils.lerp(REST.rightLowerArm.z, -0.087, raise);
      const hand = {
        x: THREE.MathUtils.lerp(REST.rightHand.x, 0.35, raise),
        y: THREE.MathUtils.lerp(REST.rightHand.y, 0.65, raise),
        z: THREE.MathUtils.lerp(REST.rightHand.z, -1.15, raise),
      };
      const curl = FIST_CURL(raise);
      const restF = FINGER_REST();
      const mix = (a: THREE.Euler, b: THREE.Euler) =>
        new THREE.Euler(
          THREE.MathUtils.lerp(a.x, b.x, raise),
          THREE.MathUtils.lerp(a.y, b.y, raise),
          THREE.MathUtils.lerp(a.z, b.z, raise),
        );
      return {
        rightUpperArm: new THREE.Euler(armX, armY, armZ),
        rightLowerArm: new THREE.Euler(elbX, elbY, elbZ),
        rightHand:     new THREE.Euler(hand.x, hand.y, hand.z),
        fingers: {
          rIndex1:  mix(restF.rIndex1!, curl.rIndex1!),
          rIndex2:  mix(restF.rIndex2!, curl.rIndex2!),
          rMiddle1: mix(restF.rMiddle1!, curl.rMiddle1!),
          rMiddle2: mix(restF.rMiddle2!, curl.rMiddle2!),
          rRing1:   mix(restF.rRing1!, curl.rRing1!),
          rRing2:   mix(restF.rRing2!, curl.rRing2!),
          rLittle1: mix(restF.rLittle1!, curl.rLittle1!),
          rLittle2: mix(restF.rLittle2!, curl.rLittle2!),
        },
      };
    }

    // Step 5.2 — Excited
    // Restrained happy bounce: both arms lift slightly and pump once, chest
    // rises/falls twice with a decaying envelope. No continuous rhythm.
    function emoteExcited(t: number, globalTime: number): BoneOverride {
      const decay = Math.exp(-t * 1.6);
      const lift = easeInOut(clamp01(t * 2.4));
      const pump = Math.abs(Math.sin(globalTime * 7.0)) * decay;
      const armZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, 0.95, lift) - pump * 0.12;
      const armZL = THREE.MathUtils.lerp(REST.leftUpperArm.z, -0.95, lift) + pump * 0.12;
      const bounce = Math.abs(Math.sin(globalTime * 7.0)) * 0.02 * decay;
      return {
        spine:        new THREE.Euler(0.02 + bounce * 0.5, 0, 0),
        chest:        new THREE.Euler(bounce, 0, 0),
        upperChest:   new THREE.Euler(bounce * 0.7, 0, 0),
        neck:         new THREE.Euler(-0.04 * lift, 0, 0),
        head:         new THREE.Euler(-0.07 * lift, 0, 0),
        leftShoulder: new THREE.Euler(0, 0, 0.05 * lift + pump * 0.02),
        rightShoulder:new THREE.Euler(0, 0, -0.05 * lift - pump * 0.02),
        rightUpperArm:new THREE.Euler(0, REST.rightUpperArm.y + 0.10 * lift, armZ),
        leftUpperArm: new THREE.Euler(0, REST.leftUpperArm.y - 0.10 * lift, armZL),
        rightLowerArm:new THREE.Euler(0, REST.rightLowerArm.y + 0.25 * lift, REST.rightLowerArm.z),
        leftLowerArm: new THREE.Euler(0, REST.leftLowerArm.y - 0.25 * lift, REST.leftLowerArm.z),
      };
    }

    // Step 5.3 — Curious Tilt
    // Gentle head tilt with a slight upper-body lean; eased in and HELD (the
    // blend-out returns naturally). No large rotation.
    function emoteCuriousTilt(t: number, _globalTime: number): BoneOverride {
      const c = easeInOut(clamp01(t * 2.0));
      return {
        head:         new THREE.Euler(0.02 * c, 0.10 * c, 0.15 * c),
        neck:         new THREE.Euler(0.01 * c, 0.05 * c, 0.07 * c),
        upperChest:   new THREE.Euler(0, 0, 0.03 * c),
        spine:        new THREE.Euler(0, 0, 0.02 * c),
      };
    }

    // Step 5.4 — Gentle Greeting
    // A soft alternative to the full wave: modest arm raise, small greeting
    // motion, one subtle head nod. Clearly smaller than the wave.
    function emoteGentleGreeting(t: number, globalTime: number): BoneOverride {
      const raise = easeInOut(clamp01(t * 2.6));
      const wave = Math.sin(globalTime * 5.5) * 0.10 * raise;
      const nod = Math.sin(globalTime * 6.0) * Math.exp(-globalTime * 2.4) * 0.06;
      const armZ = THREE.MathUtils.lerp(REST.rightUpperArm.z, 0.72, raise);
      const elbY = THREE.MathUtils.lerp(REST.rightLowerArm.y, 0.85, raise);
      return {
        head:         new THREE.Euler(nod, 0, 0),
        neck:         new THREE.Euler(nod * 0.5, 0, 0),
        rightUpperArm:new THREE.Euler(0, REST.rightUpperArm.y, armZ),
        rightLowerArm:new THREE.Euler(0, elbY, wave),
        rightHand:    new THREE.Euler(REST.rightHand.x + wave * 0.4, REST.rightHand.y, REST.rightHand.z),
      };
    }

    // Step 5.5 — Shy
    // Head lowered with a small tilt, arms folded modestly in front-low
    // (hands near each other, FK-checked ≈15 cm apart at hip-chest height),
    // shoulders drawn slightly inward. Held, then released.
    function emoteShy(t: number, _globalTime: number): BoneOverride {
      const c = easeInOut(clamp01(t * 2.0));
      return {
        head:         new THREE.Euler(0.14 * c, 0, 0.06 * c),
        neck:         new THREE.Euler(0.06 * c, 0, 0.03 * c),
        spine:        new THREE.Euler(0.03 * c, 0, 0),
        leftShoulder: new THREE.Euler(0, 0, -0.04 * c),
        rightShoulder:new THREE.Euler(0, 0, 0.04 * c),
        rightUpperArm:new THREE.Euler(0, THREE.MathUtils.lerp(REST.rightUpperArm.y, 0.30, c), THREE.MathUtils.lerp(REST.rightUpperArm.z, 1.10, c)),
        leftUpperArm: new THREE.Euler(0, THREE.MathUtils.lerp(REST.leftUpperArm.y, -0.30, c), THREE.MathUtils.lerp(REST.leftUpperArm.z, -1.10, c)),
        rightLowerArm:new THREE.Euler(0, THREE.MathUtils.lerp(REST.rightLowerArm.y, 0.75, c), REST.rightLowerArm.z),
        leftLowerArm: new THREE.Euler(0, THREE.MathUtils.lerp(REST.leftLowerArm.y, -0.75, c), REST.leftLowerArm.z),
        rightHand:    new THREE.Euler(0, 0.15 * c, REST.rightHand.z),
        leftHand:     new THREE.Euler(0, -0.15 * c, REST.leftHand.z),
      };
    }

    // Step 5.6 — Attentive Listening (CONTINUOUS)
    // Slight forward incline of the head with a subtle tilt; body still. Runs as
    // a sustained emote for as long as the ambient voice-listening state is
    // active (same machinery as the sustained thinking hold).
    function emoteAttentiveListening(_t: number, _globalTime: number): BoneOverride {
      return {
        head:         new THREE.Euler(0.10, 0.06, 0.05),
        neck:         new THREE.Euler(0.05, 0.03, 0.03),
        upperChest:   new THREE.Euler(0.02, 0, 0),
      };
    }

    // Mapping of emote ID to calculation function
    const EMOTE_FN: Record<EmoteId, (t: number, gt: number) => BoneOverride> = {
      wave:       emoteWave,
      bow:        emoteBow,
      dance:      emoteDance,
      nod:        emoteNod,
      shake_head: emoteShakeHead,
      point:      emotePoint,
      laugh:      emoteLaugh,
      sad:        emoteSad,
      angry:      emoteAngry,
      surprised:  emoteSurprised,
      thinking:   emoteThinking,
      clap:       emoteClap,
      shrug:      emoteShrug,
      facepalm:   emoteFacepalm,
      thumbs_up:  emoteThumbsUp,
      excited:    emoteExcited,
      curious_tilt: emoteCuriousTilt,
      gentle_greeting: emoteGentleGreeting,
      shy:        emoteShy,
      attentive_listening: emoteAttentiveListening,
    };

    // Parameters for each emote
    const EMOTE_PARAMS: Record<
      EmoteId,
      {
        duration: number;
        blendIn: number;
        blendOut: number;
        loop: boolean;
        expression?: SupportedVrmExpression;
      }
    > = {
      wave:       { duration: 2.8, blendIn: 0.35, blendOut: 0.45, loop: false, expression: 'happy' },
      bow:        { duration: 2.2, blendIn: 0.30, blendOut: 0.45, loop: false, expression: 'relaxed' },
      dance:      { duration: 999, blendIn: 0.50, blendOut: 0.60, loop: true,  expression: 'happy' },
      nod:        { duration: 1.6, blendIn: 0.12, blendOut: 0.30, loop: false, expression: 'relaxed' },
      shake_head: { duration: 1.6, blendIn: 0.12, blendOut: 0.30, loop: false, expression: 'neutral' },
      point:      { duration: 2.2, blendIn: 0.30, blendOut: 0.40, loop: false, expression: 'surprised' },
      laugh:      { duration: 2.2, blendIn: 0.25, blendOut: 0.45, loop: false, expression: 'happy' },
      sad:        { duration: 2.6, blendIn: 0.45, blendOut: 0.55, loop: false, expression: 'sad' },
      angry:      { duration: 2.0, blendIn: 0.30, blendOut: 0.45, loop: false, expression: 'angry' },
      surprised:  { duration: 1.6, blendIn: 0.12, blendOut: 0.45, loop: false, expression: 'surprised' },
      thinking:   { duration: 3.2, blendIn: 0.40, blendOut: 0.55, loop: false, expression: 'neutral' },
      clap:       { duration: 2.4, blendIn: 0.30, blendOut: 0.40, loop: false, expression: 'happy' },
      shrug:      { duration: 2.2, blendIn: 0.30, blendOut: 0.45, loop: false, expression: 'relaxed' },
      facepalm:   { duration: 2.6, blendIn: 0.35, blendOut: 0.50, loop: false, expression: 'neutral' },
      thumbs_up:  { duration: 2.6, blendIn: 0.30, blendOut: 0.45, loop: false, expression: 'happy' },
      excited:    { duration: 2.2, blendIn: 0.25, blendOut: 0.45, loop: false, expression: 'happy' },
      curious_tilt: { duration: 2.4, blendIn: 0.30, blendOut: 0.50, loop: false, expression: 'surprised' },
      gentle_greeting: { duration: 2.2, blendIn: 0.30, blendOut: 0.45, loop: false, expression: 'relaxed' },
      shy:        { duration: 2.6, blendIn: 0.40, blendOut: 0.55, loop: false, expression: 'relaxed' },
      attentive_listening: { duration: 3.2, blendIn: 0.40, blendOut: 0.55, loop: false, expression: 'neutral' },
    };

    // ── Active emote state & transition management ───────────────────────────
    let activeEmote: EmoteState | null = null;
    let pendingEmote: EmoteId | null = null;
    let pendingSource: EmoteSource = 'console';

    // Track previous values of behavior signals to trigger once per signal event
    let prevGreeting = false;
    let prevThanked = false;
    let prevLookDir: string | null = null;
    let prevEmotionSig = '';

    function capturePose(hum: NonNullable<VRM['humanoid']>): BoneOverride {
      const snap: BoneOverride = {};
      for (const [key, name] of EMOTE_BONES) {
        const node = hum.getNormalizedBoneNode(name);
        if (node) snap[key] = new THREE.Euler(node.rotation.x, node.rotation.y, node.rotation.z);
      }
      const fingers: FingerOverride = {};
      let anyFinger = false;
      for (const [key, name] of FINGER_BONES) {
        const node = hum.getNormalizedBoneNode(name);
        if (node) {
          fingers[key] = new THREE.Euler(node.rotation.x, node.rotation.y, node.rotation.z);
          anyFinger = true;
        }
      }
      if (anyFinger) snap.fingers = fingers;
      return snap;
    }

    function startEmote(id: EmoteId, sustained = false, source: EmoteSource = 'console') {
      const p = EMOTE_PARAMS[id];
      // Never restart an emote that is already playing — repeated triggers must not
      // reset its clock (this was the cause of continuous twitchy restarts).
      if (activeEmote) {
        const stillPlaying =
          activeEmote.loop || activeEmote.elapsed < activeEmote.duration - activeEmote.blendOut;
        if (activeEmote.id === id && stillPlaying) return;
      }
      // When interrupting a playing emote, freeze the current blended pose and
      // blend the new gesture in from it instead of snapping.
      const humNow = vrmRef.current?.humanoid ?? null;
      const snapshot = activeEmote && humNow ? capturePose(humNow) : null;
      activeEmote = {
        id,
        elapsed: 0,
        // Sustained gestures keep their normal duration so holdT (which drives
        // pose entry) still progresses; loop=true prevents self-termination and
        // stopActiveEmote() converts the remainder into the blend-out.
        duration: p.duration,
        blendIn: p.blendIn,
        blendOut: p.blendOut,
        loop: sustained ? true : p.loop,
        blendWeight: 0,
        source,
        snapshot,
      };
    }

    function stopActiveEmote() {
      if (activeEmote && !activeEmote.loop) {
        if (activeEmote.elapsed < activeEmote.duration - activeEmote.blendOut) {
          activeEmote.elapsed = activeEmote.duration - activeEmote.blendOut;
        }
      } else if (activeEmote && activeEmote.loop) {
        activeEmote.loop = false;
        activeEmote.duration = activeEmote.elapsed + activeEmote.blendOut;
      }
    }

    // Connect external programmatic trigger
    triggerEmoteRef.current = (id: EmoteId) => {
      if (EMOTE_PARAMS[id]) {
        pendingEmote = id;
        pendingSource = 'console';
      }
    };

    // Helper: blend a bone between a source pose (idle base or interruption
    // snapshot) and the gesture target. Absolute set every frame — no drift.
    function applyBoneOverride(
      bone: THREE.Object3D | null,
      target: THREE.Euler,
      sourceValue: THREE.Euler,
      weight: number,
    ) {
      if (!bone) return;
      bone.rotation.x = THREE.MathUtils.lerp(sourceValue.x, target.x, weight);
      bone.rotation.y = THREE.MathUtils.lerp(sourceValue.y, target.y, weight);
      bone.rotation.z = THREE.MathUtils.lerp(sourceValue.z, target.z, weight);
    }

    // ── RAF animate ───────────────────────────────────────────────────────────
    // Preallocated idle-base Eulers (set per frame; avoids per-frame allocation).
    const idleRUA = new THREE.Euler();
    const idleLUA = new THREE.Euler();
    const idleRLA = new THREE.Euler();
    const idleLLA = new THREE.Euler();
    const idleRH  = new THREE.Euler();
    const idleLH  = new THREE.Euler();
    const idleChestE = new THREE.Euler();
    const idleSpineE = new THREE.Euler();
    const idleUpperChestE = new THREE.Euler();
    const idleNeckE = new THREE.Euler();
    const idleHeadE = new THREE.Euler();
    const IDLE_SHOULDER = new THREE.Euler(0, 0, 0);
    const fingerRest = FINGER_REST();

    const animate = () => {
      rafRef.current = requestAnimationFrame(animate);
      // Clamp delta so a throttled/background tab waking up cannot advance an
      // emote's clock by seconds in a single frame (prevents snap/expiry jumps).
      const delta = Math.min(clockRef.current.getDelta(), 0.1);
      const vrm = vrmRef.current;
      if (!vrm) {
        renderer.render(scene, camera);
        return;
      }

      time += delta;
      const em = vrm.expressionManager;
      const hum = vrm.humanoid;

      // ── STEP 1: Autonomous signal evaluation & emote selection ─────────────
      // Priority 1: Continuous Dance state
      if (isDancingRef.current) {
        if (activeEmote?.id !== 'dance') {
          startEmote('dance');
        }
      } else if (activeEmote?.id === 'dance') {
        stopActiveEmote();
      }

      // Priority 1.5: Sustained thinking tied to the existing response lifecycle.
      // `isListening` (App: isLoading) means "Krisha is preparing a response";
      // `speakingRef` (App: isSpeaking) means "Krisha started talking". Thinking
      // is ENTERED when processing begins and HOLDS for the whole preparation,
      // preempting only ambient 'emotion'-sourced gestures (explicit command
      // gestures and console/test triggers still play out first; thinking resumes
      // after them). It EXITS when speech begins or processing ends — covering
      // success→speech, failure and cancellation alike. No new controller or AI
      // decision: this reuses the existing props.
      const thinkingHold = isListeningRef.current && !speakingRef.current && !isDancingRef.current;
      if (thinkingHold) {
        const e = activeEmote;
        const preemptible = !e
          || (e.id === 'thinking' && !e.loop)
          || e.source === 'emotion'
          || e.id === 'attentive_listening';
        if (preemptible) {
          startEmote('thinking', true, 'lifecycle');
        }
      } else if (activeEmote?.id === 'thinking' && activeEmote.loop) {
        stopActiveEmote();
      }

      // Priority 1.6: Attentive listening tied to the ambient voice-listening
      // signal (App: wakeWordStatus 'listening'/'detected' → isVoiceListening).
      // Sustained while the user is being heard; yields to the response
      // lifecycle (preparation → thinking) and to speech.
      const attentiveHold =
        isVoiceListeningRef.current &&
        !isListeningRef.current &&
        !speakingRef.current &&
        !isDancingRef.current;
      if (attentiveHold) {
        const e = activeEmote;
        const preemptible = !e
          || (e.id === 'attentive_listening' && !e.loop)
          || e.source === 'emotion';
        if (preemptible) {
          startEmote('attentive_listening', true, 'lifecycle');
        }
      } else if (activeEmote?.id === 'attentive_listening' && activeEmote.loop) {
        stopActiveEmote();
      }

      // Priority 2: One-shot event transitions (when not actively dancing)
      if (!isDancingRef.current) {
        // Greeting command (wave)
        if (isGreetingRef.current && !prevGreeting) {
          pendingEmote = 'wave';
          pendingSource = 'command';
        }
        // Thanked command (bow)
        if (isThankedRef.current && !prevThanked) {
          pendingEmote = 'bow';
          pendingSource = 'command';
        }
        // Direction change to "different_directions" (shrug)
        if (lookDirectionRef.current === 'different_directions' && prevLookDir !== 'different_directions') {
          pendingEmote = 'shrug';
          pendingSource = 'command';
        }

        // New emotional turn from user/AI conversation.
        // Compared by CONTENT signature (not object identity) so re-renders that
        // pass an equivalent object cannot re-fire gestures.
        const ed = emotionDataRef.current;
        const edSig = ed
          ? `${ed.sentiment}|${ed.expression}|${ed.gesture}|${Math.round(ed.intensity * 10)}|${Math.round(ed.blushLevel * 10)}`
          : '';
        if (edSig !== prevEmotionSig) {
          prevEmotionSig = edSig;
          let emotionEmote: EmoteId | null = null;
          if (ed) {
            if (ed.sentiment === 'teasing' || ed.expression === 'playful_smirk') {
              if (ed.blushLevel >= 0.5 || ed.gesture === 'shyness') {
                emotionEmote = 'facepalm';
              } else if (ed.intensity >= 0.75) {
                emotionEmote = 'laugh';
              }
            } else if (ed.sentiment === 'positive' || ed.expression === 'happy_sparkle') {
              if (ed.expression === 'happy_sparkle' && ed.intensity >= 0.85) {
                emotionEmote = 'excited';
              } else if (ed.gesture === 'perk_up') {
                emotionEmote = 'thumbs_up';
              } else if (ed.intensity >= 0.90) {
                emotionEmote = 'clap';
              } else if (ed.gesture === 'subtle_nod' || ed.intensity >= 0.70) {
                emotionEmote = 'nod';
              }
            } else if (ed.sentiment === 'reflective' || ed.expression === 'thoughtful_gaze') {
              emotionEmote = 'thinking';
            } else if (ed.sentiment === 'jealous' || ed.expression === 'pout_jealous') {
              emotionEmote = 'angry';
            } else if (ed.sentiment === 'curious' || ed.expression === 'curious_tilt') {
              if (ed.gesture === 'glance_away') {
                emotionEmote = 'shrug';
              } else if (ed.gesture === 'tilt_left' || ed.gesture === 'tilt_right') {
                emotionEmote = 'curious_tilt';
              } else if (ed.intensity >= 0.70) {
                emotionEmote = 'surprised';
              } else {
                emotionEmote = 'point';
              }
            } else if ((ed.expression as string) === 'sad') {
              emotionEmote = 'sad';
            } else if (ed.gesture === 'shyness') {
              emotionEmote = 'shy';
            } else if (ed.sentiment === 'affectionate') {
              emotionEmote = 'gentle_greeting';
            }
          }
          if (emotionEmote) {
            // Ambient emotion gestures yield to the response-lifecycle thinking
            // hold (see Priority 1.5), so they are never queued ahead of it.
            if (!(isListeningRef.current && !speakingRef.current && !isDancingRef.current)) {
              pendingEmote = emotionEmote;
              pendingSource = 'emotion';
            }
          }
        }
      }

      prevGreeting = isGreetingRef.current;
      prevThanked = isThankedRef.current;
      prevLookDir = lookDirectionRef.current;

      // Handle pending emote requests (from events or developer console)
      if (pendingEmote) {
        startEmote(pendingEmote, false, pendingSource);
        pendingEmote = null;
        pendingSource = 'console';
      }

      // Advance active emote progress
      if (activeEmote) {
        activeEmote.elapsed += delta;
        const e = activeEmote;
        const dur = e.duration;
        const bi = e.blendIn;
        const bo = e.blendOut;

        if (!e.loop && e.elapsed >= dur) {
          activeEmote = null;
        } else {
          if (e.elapsed < bi) {
            e.blendWeight = easeInOut(e.elapsed / bi);
          } else if (!e.loop && e.elapsed > dur - bo) {
            e.blendWeight = easeInOut((dur - e.elapsed) / bo);
          } else {
            e.blendWeight = 1.0;
          }
          e.blendWeight = clamp01(e.blendWeight);
        }
      }
      activeEmoteIdRef.current = activeEmote?.id ?? null;

      // ── STEP 2: Idle breathing & micro-posture (nearly motionless) ─────────
      // Single slow breath (~0.24 Hz) and a barely visible posture drift.
      const breath = Math.sin(time * 1.5) * 0.012;
      const postureSway = Math.sin(time * 0.17) * 0.005;

      if (hum) {
        const chest = hum.getNormalizedBoneNode(VRMHumanBoneName.Chest);
        const spine = hum.getNormalizedBoneNode(VRMHumanBoneName.Spine);
        const upperChest = hum.getNormalizedBoneNode(VRMHumanBoneName.UpperChest);
        const lSh = hum.getNormalizedBoneNode(VRMHumanBoneName.LeftShoulder);
        const rSh = hum.getNormalizedBoneNode(VRMHumanBoneName.RightShoulder);

        const idleChestX = breath * 0.85;
        const idleChestZ = postureSway * 0.6;
        const idleSpineX = breath * 0.55 + postureSway * 0.4;
        const idleUpperChestX = breath * 0.65;

        if (chest) { chest.rotation.x = idleChestX; chest.rotation.y = 0; chest.rotation.z = idleChestZ; }
        if (spine) { spine.rotation.x = idleSpineX; spine.rotation.y = 0; spine.rotation.z = 0; }
        if (upperChest) { upperChest.rotation.x = idleUpperChestX; upperChest.rotation.y = 0; upperChest.rotation.z = 0; }
        if (lSh) lSh.rotation.set(0, 0, 0);
        if (rSh) rSh.rotation.set(0, 0, 0);

        // ── STEP 3: Idle arm posture — the rest pose with a whisper of breath ──
        const lUA = hum.getNormalizedBoneNode(VRMHumanBoneName.LeftUpperArm);
        const rUA = hum.getNormalizedBoneNode(VRMHumanBoneName.RightUpperArm);
        const lLA = hum.getNormalizedBoneNode(VRMHumanBoneName.LeftLowerArm);
        const rLA = hum.getNormalizedBoneNode(VRMHumanBoneName.RightLowerArm);
        const lH  = hum.getNormalizedBoneNode(VRMHumanBoneName.LeftHand);
        const rH  = hum.getNormalizedBoneNode(VRMHumanBoneName.RightHand);

        idleRUA.set(REST.rightUpperArm.x, REST.rightUpperArm.y, REST.rightUpperArm.z + breath * 0.12);
        idleLUA.set(REST.leftUpperArm.x, REST.leftUpperArm.y, REST.leftUpperArm.z - breath * 0.12);
        idleRLA.set(REST.rightLowerArm.x, REST.rightLowerArm.y, REST.rightLowerArm.z);
        idleLLA.set(REST.leftLowerArm.x, REST.leftLowerArm.y, REST.leftLowerArm.z);
        idleRH.set(REST.rightHand.x, REST.rightHand.y, REST.rightHand.z);
        idleLH.set(REST.leftHand.x, REST.leftHand.y, REST.leftHand.z);

        idleChestE.set(idleChestX, 0, idleChestZ);
        idleSpineE.set(idleSpineX, 0, 0);
        idleUpperChestE.set(idleUpperChestX, 0, 0);
        idleNeckE.set(0, 0, 0);
        idleHeadE.set(0, 0, 0);

        if (rUA) rUA.rotation.set(idleRUA.x, idleRUA.y, idleRUA.z);
        if (lUA) lUA.rotation.set(idleLUA.x, idleLUA.y, idleLUA.z);
        if (rLA) rLA.rotation.set(idleRLA.x, idleRLA.y, idleRLA.z);
        if (lLA) lLA.rotation.set(idleLLA.x, idleLLA.y, idleLLA.z);
        if (rH)  rH.rotation.set(idleRH.x, idleRH.y, idleRH.z);
        if (lH)  lH.rotation.set(idleLH.x, idleLH.y, idleLH.z);

        // ── STEP 4: Evaluate the active emote ONCE and overlay it ─────────────
        // Bones NOT included in an emote's override stay on the idle base —
        // gestures are isolated by construction.
        let override: BoneOverride | null = null;
        let w = 0;
        let snapshot: BoneOverride | null = null;
        if (activeEmote && activeEmote.blendWeight > 0) {
          const e = activeEmote;
          const holdT = clamp01((e.elapsed - e.blendIn) / Math.max(e.duration - e.blendIn - e.blendOut, 0.01));
          override = EMOTE_FN[e.id](holdT, e.elapsed);
          w = e.blendWeight;
          // While blending in after an interruption, cross-fade from the frozen pose.
          if (e.snapshot && e.elapsed < e.blendIn) snapshot = e.snapshot;
          else e.snapshot = null;
        }
        const src = (key: keyof RestPose, idleE: THREE.Euler): THREE.Euler =>
          (snapshot && snapshot[key]) || idleE;

        if (override) {
          if (override.rightUpperArm) applyBoneOverride(rUA, override.rightUpperArm, src('rightUpperArm', idleRUA), w);
          if (override.rightLowerArm) applyBoneOverride(rLA, override.rightLowerArm, src('rightLowerArm', idleRLA), w);
          if (override.rightHand)     applyBoneOverride(rH,  override.rightHand,     src('rightHand', idleRH),  w);
          if (override.leftUpperArm)  applyBoneOverride(lUA, override.leftUpperArm,  src('leftUpperArm', idleLUA), w);
          if (override.leftLowerArm)  applyBoneOverride(lLA, override.leftLowerArm,  src('leftLowerArm', idleLLA), w);
          if (override.leftHand)      applyBoneOverride(lH,  override.leftHand,      src('leftHand', idleLH),  w);

          if (override.leftShoulder)  applyBoneOverride(lSh, override.leftShoulder,  src('leftShoulder', IDLE_SHOULDER), w);
          if (override.rightShoulder) applyBoneOverride(rSh, override.rightShoulder, src('rightShoulder', IDLE_SHOULDER), w);

          if (override.spine)      applyBoneOverride(spine, override.spine, src('spine', idleSpineE), w);
          if (override.chest)      applyBoneOverride(chest, override.chest, src('chest', idleChestE), w);
          if (override.upperChest) applyBoneOverride(upperChest, override.upperChest, src('upperChest', idleUpperChestE), w);

          // Finger overrides (thumbs_up): blend from the captured finger pose or
          // the finger rest (identity) toward the gesture's finger targets.
          if (override.fingers) {
            for (const [key, name] of FINGER_BONES) {
              const fe = override.fingers[key];
              if (!fe) continue;
              const node = hum.getNormalizedBoneNode(name);
              if (!node) continue;
              const sourceE = (snapshot?.fingers && snapshot.fingers[key]) || fingerRest[key];
              applyBoneOverride(node, fe, sourceE, w);
            }
          }
        }

        // ── STEP 5: Head & neck — subtle idle gaze plus emote overlay ─────────
        const neck = hum.getNormalizedBoneNode(VRMHumanBoneName.Neck);
        const head = hum.getNormalizedBoneNode(VRMHumanBoneName.Head);

        const idleYaw = Math.sin(time * 0.31) * 0.020 + Math.sin(time * 0.13) * 0.010;
        const idlePitch = Math.sin(time * 0.23 + 1.0) * 0.014;
        const idleRoll = Math.sin(time * 0.17 + 2.0) * 0.008;

        let targetYaw = idleYaw;
        let targetPitch = idlePitch;
        let targetRoll = idleRoll;

        const lookDir = lookDirectionRef.current;
        if (lookDir === 'left')  targetYaw   += -0.22;
        else if (lookDir === 'right') targetYaw += 0.22;
        else if (lookDir === 'up')    targetPitch += -0.15;
        else if (lookDir === 'down')  targetPitch += 0.15;

        // Frame-rate-independent exponential damping toward the target.
        const damp = 1 - Math.exp(-3.2 * delta);
        currentYaw = THREE.MathUtils.lerp(currentYaw, targetYaw, damp);
        currentPitch = THREE.MathUtils.lerp(currentPitch, targetPitch, damp);
        currentRoll = THREE.MathUtils.lerp(currentRoll, targetRoll, damp);

        idleNeckE.set(currentPitch * 0.35, currentYaw * 0.35, currentRoll * 0.35);
        idleHeadE.set(currentPitch * 0.65, currentYaw * 0.65, currentRoll * 0.65);

        if (neck) neck.rotation.set(idleNeckE.x, idleNeckE.y, idleNeckE.z);
        if (head) head.rotation.set(idleHeadE.x, idleHeadE.y, idleHeadE.z);

        if (override) {
          if (override.neck) applyBoneOverride(neck, override.neck, src('neck', idleNeckE), w);
          if (override.head) applyBoneOverride(head, override.head, src('head', idleHeadE), w);
        }
      }

      // ── STEP 6: Cursor-only eye tracking ───────────────────────────────────
      if (lookAtTargetRef.current && vrm.lookAt) {
        const ptr = pointerRef.current;
        const targetX = ptr.x * 1.6;
        const targetY = 1.52 + ptr.y * -0.9;
        const dampLook = 1 - Math.exp(-6.0 * delta);

        lookAtTargetRef.current.position.x = THREE.MathUtils.lerp(
          lookAtTargetRef.current.position.x, targetX, dampLook
        );
        lookAtTargetRef.current.position.y = THREE.MathUtils.lerp(
          lookAtTargetRef.current.position.y, targetY, dampLook
        );
        lookAtTargetRef.current.position.z = 2.0;
        vrm.lookAt.target = lookAtTargetRef.current;
        vrm.lookAt.autoUpdate = true;
      }

      // ── STEP 7: Periodic blinking ──────────────────────────────────────────
      blinkTimer += delta;
      if (blinkPhase === 'idle' && blinkTimer >= nextBlinkAt) {
        blinkPhase = 'closing';
        blinkProgress = 0;
      }
      if (blinkPhase === 'closing') {
        blinkProgress += delta * 14.0;
        if (blinkProgress >= 1.0) { blinkProgress = 1.0; blinkPhase = 'opening'; }
      } else if (blinkPhase === 'opening') {
        blinkProgress -= delta * 9.0;
        if (blinkProgress <= 0.0) {
          blinkProgress = 0.0;
          blinkPhase = 'idle';
          blinkTimer = 0;
          nextBlinkAt = 2.5 + Math.random() * 3.5;
          if (Math.random() < 0.15) nextBlinkAt = 0.12;
        }
      }

      // ── STEP 8: Facial expressions & lip synchronization ───────────────────
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

          // Harmonize facial expression with active emote
          if (activeEmote && activeEmote.blendWeight > 0) {
            const emoteExpr = EMOTE_PARAMS[activeEmote.id].expression;
            if (emoteExpr) {
              const currentVal = em.getValue(emoteExpr) || 0;
              em.setValue(emoteExpr, THREE.MathUtils.lerp(currentVal, 1.0, activeEmote.blendWeight * 0.80));
            }
          }

          em.setValue('blink', blinkProgress);

          // Audio lip-sync analysis
          const targetMouth = speakingRef.current ? Math.min(1.0, lipVolumeRef.current * 2.8) : 0;
          smoothMouth = THREE.MathUtils.lerp(smoothMouth, targetMouth, 1 - Math.exp(-16.0 * delta));
          if (smoothMouth < 0.015) smoothMouth = 0;
          em.setValue('aa', smoothMouth);
        }
      }

      // ── STEP 9: Spring bones (hair physics) + render ───────────────────────
      vrm.update(delta);
      renderer.render(scene, camera);
    };

    clockRef.current.start();
    animate();

    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      resizeObserver.disconnect();

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
        <div className="absolute bottom-3 right-3 z-40 flex flex-col-reverse items-end pointer-events-auto">
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
            <div className="mb-2 p-2.5 rounded-2xl backdrop-blur-xl border border-cyan-500/25 bg-[#070e22]/90 shadow-[0_12px_32px_rgba(0,0,0,0.65)] flex flex-col gap-2 max-w-[220px]">
              <div className="flex items-center justify-between text-[10px] text-slate-300 font-medium border-b border-white/10 pb-1.5">
                <span>Model Expressions:</span>
                <span className="text-cyan-400 font-mono text-[9px]">VRM 1.0</span>
              </div>

              <div className="flex flex-wrap gap-1">
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

                {[
                  { id: 'happy',    label: 'Happy 😊' },
                  { id: 'relaxed',  label: 'Relaxed 😌' },
                  { id: 'surprised',label: 'Surprised 😮' },
                  { id: 'sad',      label: 'Sad 🥺' },
                  { id: 'angry',    label: 'Angry 😠' },
                  { id: 'neutral',  label: 'Neutral 😐' },
                  { id: 'aa',       label: 'Mouth Open 🗣️' },
                  { id: 'oh',       label: 'Oh 😲' },
                  { id: 'blink',    label: 'Blink 😉' },
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
