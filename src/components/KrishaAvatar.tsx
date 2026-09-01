import React, { useState, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence, useSpring, useTransform } from 'motion/react';
import { AvatarExpression, EmotionAnalysis } from '../types';

// High-resolution character cutout images
import standingCutout from '../assets/images/krisha_standing_cutout_1787931219956.jpg';
import wavingCutout from '../assets/images/krisha_waving_cutout_1787931132967.jpg';
import heartCutout from '../assets/images/krisha_heart_cutout_1787931155821.jpg';
import playfulCutout from '../assets/images/krisha_playful_cutout_1787931185103.jpg';

export type VideoAnimationPose =
  | 'celestial_standing'
  | 'hands_on_heart'
  | 'playful_gesture'
  | 'waving_greeting';

export interface KrishaAvatarProps {
  expression: AvatarExpression;
  emotionData?: EmotionAnalysis;
  isSpeaking: boolean;
  isListening?: boolean;
  isDancing?: boolean;
  isGreeting?: boolean;
  lookDirection?: 'different_directions' | 'left' | 'right' | 'up' | 'down' | 'around' | null;
  pointerPos?: { x: number; y: number };
  forcedPose?: VideoAnimationPose | null;
  onPoseChange?: (pose: VideoAnimationPose) => void;
  onReact?: (type: 'head' | 'heart' | 'wave') => void;
  onGreetingComplete?: () => void;
}

export const KrishaAvatar: React.FC<KrishaAvatarProps> = ({
  expression = 'gentle_smile',
  emotionData,
  isSpeaking,
  isDancing = false,
  isGreeting = false,
  lookDirection = null,
  pointerPos = { x: 0, y: 0 },
  forcedPose = null,
  onPoseChange,
  onReact,
  onGreetingComplete,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoError, setVideoError] = useState(false);
  const [patReaction, setPatReaction] = useState<'none' | 'head' | 'heart' | 'wave'>('none');
  const [internalGreetingPlaying, setInternalGreetingPlaying] = useState(false);
  const [sparkleCount, setSparkleCount] = useState(0);

  // Sync greeting trigger state to ensure it plays only once per trigger
  useEffect(() => {
    if (isGreeting || patReaction === 'wave' || forcedPose === 'waving_greeting') {
      setInternalGreetingPlaying(true);
    }
  }, [isGreeting, patReaction, forcedPose]);

  // Determine active greeting/looking flags
  const isGreetingActive =
    internalGreetingPlaying &&
    (isGreeting || patReaction === 'wave' || forcedPose === 'waving_greeting');
  const isLookingActive = Boolean(lookDirection);

  // Expression normalization
  const currentExpression: AvatarExpression = useMemo(() => {
    if (expression === 'warm') return 'gentle_smile';
    if (expression === 'playful') return 'playful_smirk';
    if (expression === 'pout') return 'pout_jealous';
    if (expression === 'happy') return 'happy_sparkle';
    if (expression === 'listening') return 'listening_attentive';
    return expression || 'gentle_smile';
  }, [expression]);

  const blushLevel = useMemo(() => {
    if (patReaction === 'head') return 0.9;
    if (patReaction === 'heart') return 0.8;
    if (emotionData?.blushLevel !== undefined) return emotionData.blushLevel;
    if (currentExpression === 'flustered_blush') return 0.85;
    if (currentExpression === 'pout_jealous') return 0.55;
    if (currentExpression === 'playful_smirk') return 0.4;
    if (currentExpression === 'happy_sparkle') return 0.35;
    return 0.2;
  }, [patReaction, emotionData, currentExpression]);

  // Determine active visual pose / mode
  const activePose: VideoAnimationPose = useMemo(() => {
    if (forcedPose) return forcedPose;
    if (isDancing) return 'waving_greeting';
    if (isGreetingActive) return 'waving_greeting';
    if (patReaction === 'heart') return 'hands_on_heart';
    if (patReaction === 'head') return 'hands_on_heart';

    if (
      currentExpression === 'flustered_blush' ||
      currentExpression === 'thoughtful_gaze' ||
      currentExpression === 'listening_attentive'
    ) {
      return 'hands_on_heart';
    }
    if (
      currentExpression === 'playful_smirk' ||
      currentExpression === 'curious_tilt' ||
      currentExpression === 'pout_jealous' ||
      currentExpression === 'happy_sparkle'
    ) {
      return 'playful_gesture';
    }
    return 'celestial_standing';
  }, [forcedPose, isDancing, isGreetingActive, patReaction, currentExpression]);

  // Determine the exact single video clip to play (Zero background decoder overhead)
  const activeVideoSrc = useMemo(() => {
    if (isDancing) {
      return '/assets/videos/ANIME%20GIRL%20DANCING.mp4';
    }
    if (isLookingActive) {
      return '/assets/videos/ANIME%20GIRL%20LOOKING%20IN%20DIFFRENT%20DIRECTIONS.mp4';
    }
    if (isGreetingActive) {
      return '/assets/videos/ANIME%20GIRL%20GREETING.mp4';
    }
    if (isSpeaking) {
      return '/assets/videos/ANIME%20GIRL%20TALKING.mp4';
    }
    return '/assets/videos/ANIME%20GIRL%20STANDING%20QUIETLY.mp4';
  }, [isDancing, isLookingActive, isGreetingActive, isSpeaking]);

  const isGreetingVideo = activeVideoSrc.includes('GREETING');
  const shouldLoopVideo = !isGreetingVideo; // Stand quietly loops; greeting video runs strictly ONCE

  const handleVideoEnded = () => {
    if (isGreetingVideo || isGreetingActive) {
      setInternalGreetingPlaying(false);
      setPatReaction('none');
      if (onGreetingComplete) {
        onGreetingComplete();
      }
    }
  };

  // Active cutout image fallback based on pose
  const activeCutout = useMemo(() => {
    switch (activePose) {
      case 'waving_greeting':
        return wavingCutout;
      case 'hands_on_heart':
        return heartCutout;
      case 'playful_gesture':
        return playfulCutout;
      case 'celestial_standing':
      default:
        return standingCutout;
    }
  }, [activePose]);

  // 2.5D Parallax Physics with Springs
  const smoothX = useSpring(pointerPos.x, { stiffness: 60, damping: 20 });
  const smoothY = useSpring(pointerPos.y, { stiffness: 60, damping: 20 });

  useEffect(() => {
    smoothX.set(pointerPos.x);
    smoothY.set(pointerPos.y);
  }, [pointerPos.x, pointerPos.y, smoothX, smoothY]);

  const bodyRotateY = useTransform(smoothX, [-1, 1], [-7, 7]);
  const bodyRotateX = useTransform(smoothY, [-1, 1], [4, -4]);

  // Single-video memory-optimized playback controller
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let isCancelled = false;

    const playVideo = async () => {
      try {
        video.muted = true;
        if (!document.hidden && !isCancelled) {
          await video.play();
        }
      } catch {
        // autoplay restriction or video error
      }
    };

    setVideoError(false);
    playVideo();

    // Tab visibility optimization: pause when backgrounded to prevent battery/RAM heating
    const handleVisibility = () => {
      if (document.hidden) {
        try {
          video.pause();
        } catch {}
      } else {
        playVideo();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      isCancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [activeVideoSrc]);

  // Interactive touch handlers
  const handleHeadClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPatReaction('head');
    setSparkleCount((c) => c + 1);
    if (onPoseChange) onPoseChange('hands_on_heart');
    if (onReact) onReact('head');
    setTimeout(() => setPatReaction('none'), 2400);
  };

  const handleHeartClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPatReaction('heart');
    setSparkleCount((c) => c + 1);
    if (onPoseChange) onPoseChange('hands_on_heart');
    if (onReact) onReact('heart');
    setTimeout(() => setPatReaction('none'), 2400);
  };

  const handleBodyClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setPatReaction('wave');
    setSparkleCount((c) => c + 1);
    if (onPoseChange) onPoseChange('waving_greeting');
    if (onReact) onReact('wave');
    setTimeout(() => setPatReaction('none'), 2400);
  };

  return (
    <div className="relative flex flex-col items-center justify-end w-full h-[580px] select-none pointer-events-auto overflow-visible ml-[400px] mt-[350px]">
      {/* 1. FLOATING REACTION HEARTS & SPARKLES */}
      <AnimatePresence>
        {patReaction !== 'none' && (
          <motion.div
            key={`sparkle_${sparkleCount}`}
            initial={{ opacity: 0, scale: 0.5, y: 0 }}
            animate={{ opacity: 1, scale: [0.8, 1.25, 1], y: -70 }}
            exit={{ opacity: 0, scale: 0.6, y: -100 }}
            transition={{ duration: 1.4, ease: 'easeOut' }}
            className="absolute top-8 z-40 flex items-center gap-2 pointer-events-none"
          >
            {patReaction === 'head' && (
              <>
                <span className="text-3xl filter drop-shadow-[0_0_12px_#fde047]">✨</span>
                <span className="text-4xl filter drop-shadow-[0_0_16px_#f43f5e]">💖</span>
                <span className="text-2xl filter drop-shadow-[0_0_10px_#38bdf8]">⭐</span>
              </>
            )}
            {patReaction === 'heart' && (
              <>
                <span className="text-4xl filter drop-shadow-[0_0_16px_#ec4899]">💗</span>
                <span className="text-3xl filter drop-shadow-[0_0_12px_#38bdf8]">✨</span>
                <span className="text-2xl filter drop-shadow-[0_0_10px_#60a5fa]">💎</span>
              </>
            )}
            {patReaction === 'wave' && (
              <>
                <span className="text-3xl filter drop-shadow-[0_0_12px_#38bdf8]">👋</span>
                <span className="text-4xl filter drop-shadow-[0_0_16px_#fde047]">✨</span>
                <span className="text-2xl filter drop-shadow-[0_0_10px_#38bdf8]">⭐</span>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* 2. 2.5D PARALLAX & ANIMATED CHARACTER CONTAINER */}
      <motion.div
        animate={
          lookDirection === 'different_directions' || lookDirection === 'around'
            ? {
                x: [-14, 14, -10, 10, -4, 0],
                y: [-6, 5, -4, 5, -2, 0],
                rotate: [-2, 2, -1.5, 1.5, 0],
              }
            : lookDirection === 'left'
            ? { x: -18, y: 0, rotate: -1.8 }
            : lookDirection === 'right'
            ? { x: 18, y: 0, rotate: 1.8 }
            : lookDirection === 'up'
            ? { x: 0, y: -12, rotate: -0.5 }
            : lookDirection === 'down'
            ? { x: 0, y: 12, rotate: 0.5 }
            : {
                x: 0,
                y: isDancing
                  ? [0, -10, 0, -5, 0]
                  : patReaction === 'head'
                  ? [0, 3, 0]
                  : patReaction === 'wave'
                  ? [0, -6, 0]
                  : isSpeaking
                  ? [0, -3, 0]
                  : [0, -5, 1, 0],
                rotate: isDancing
                  ? [-2, 2, -1.5, 1.5, 0]
                  : currentExpression === 'playful_smirk'
                  ? 1.5
                  : currentExpression === 'curious_tilt'
                  ? -2
                  : 0,
              }
        }
        transition={
          lookDirection === 'different_directions' || lookDirection === 'around'
            ? {
                x: { duration: 4.8, repeat: Infinity, ease: 'easeInOut' },
                y: { duration: 4.8, repeat: Infinity, ease: 'easeInOut' },
                rotate: { duration: 4.8, repeat: Infinity, ease: 'easeInOut' },
              }
            : lookDirection
            ? { duration: 0.5, ease: 'easeOut' }
            : {
                y: {
                  duration: isDancing ? 1.6 : isSpeaking ? 0.5 : 4.4,
                  repeat: patReaction === 'none' ? Infinity : 0,
                  ease: 'easeInOut',
                },
                rotate: {
                  duration: isDancing ? 1.6 : undefined,
                  repeat: isDancing ? Infinity : 0,
                  type: isDancing ? undefined : 'spring',
                  stiffness: isDancing ? undefined : 90,
                  damping: isDancing ? undefined : 16,
                  ease: isDancing ? 'easeInOut' : undefined,
                },
              }
        }
        className="relative z-10 w-[340px] sm:w-[380px] md:w-[420px] h-[580px] flex items-center justify-center perspective-[1000px]"
      >
        {/* 2.5D Parallax Interactive Wrapper */}
        <motion.div
          style={{
            rotateY: bodyRotateY,
            rotateX: bodyRotateX,
            transformStyle: 'preserve-3d',
          }}
          className="relative w-full h-full flex flex-col items-center justify-end overflow-visible"
        >
          {/* SINGLE HIGH-PERFORMANCE VIDEO LAYER (Ultra-low RAM & CPU footprint) */}
          <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-3xl z-10 pointer-events-none">
            {!videoError ? (
              <video
                ref={videoRef}
                key={activeVideoSrc}
                src={activeVideoSrc}
                autoPlay
                loop={shouldLoopVideo}
                muted
                playsInline
                preload="metadata"
                onEnded={handleVideoEnded}
                onError={() => setVideoError(true)}
                className="w-full h-full object-contain transition-opacity duration-300"
              />
            ) : (
              /* Fallback cutout image only if video fails */
              <motion.img
                src={activeCutout}
                alt="Krisha"
                className="w-full h-full object-contain drop-shadow-[0_15px_30px_rgba(0,0,0,0.6)] select-none pointer-events-none"
                animate={{
                  scale: isSpeaking ? [1, 1.015, 1] : [1, 1.008, 1],
                }}
                transition={{ duration: isSpeaking ? 0.35 : 3.6, repeat: Infinity, ease: 'easeInOut' }}
              />
            )}
          </div>

          {/* DYNAMIC CHEEK BLUSH BLOOM OVERLAY */}
          <motion.div
            animate={{
              opacity: blushLevel > 0.15 ? blushLevel : 0,
              scale: blushLevel > 0.6 ? [1, 1.08, 1] : 1,
            }}
            transition={{ duration: 0.3 }}
            className="absolute top-[22%] left-1/2 -translate-x-1/2 w-36 h-12 flex items-center justify-between px-2 z-25 pointer-events-none"
          >
            <div className="w-10 h-6 rounded-full bg-rose-500/50 blur-[6px]" />
            <div className="w-10 h-6 rounded-full bg-rose-500/50 blur-[6px]" />
          </motion.div>

          {/* HEART PULSE LIGHT OVERLAY (When hands on heart / flustered) */}
          {activePose === 'hands_on_heart' && (
            <motion.div
              animate={{
                scale: [1, 1.25, 1],
                opacity: [0.3, 0.7, 0.3],
              }}
              transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute top-[38%] left-1/2 -translate-x-1/2 w-20 h-20 rounded-full bg-rose-400/30 blur-xl z-20 pointer-events-none"
            />
          )}

          {/* 4. INTERACTIVE TOUCH HOTSPOTS */}
          {/* Head Touch Hotspot (Headpat) */}
          <div
            id="krisha-head-touch-hotspot"
            onClick={handleHeadClick}
            title="Pat Krisha's head ✨"
            className="absolute top-[8%] left-1/2 -translate-x-1/2 w-48 h-36 cursor-pointer z-30 rounded-full hover:bg-cyan-400/10 transition-colors"
          />

          {/* Heart Touch Hotspot */}
          <div
            id="krisha-heart-touch-hotspot"
            onClick={handleHeartClick}
            title="Touch Krisha's heart 💖"
            className="absolute top-[34%] left-1/2 -translate-x-1/2 w-44 h-28 cursor-pointer z-30 rounded-full hover:bg-rose-400/10 transition-colors"
          />

          {/* Body / Gown Touch Hotspot (Greeting Wave) */}
          <div
            id="krisha-body-touch-hotspot"
            onClick={handleBodyClick}
            title="Greet Krisha 👋"
            className="absolute top-[52%] left-1/2 -translate-x-1/2 w-52 h-64 cursor-pointer z-30 rounded-3xl hover:bg-blue-400/10 transition-colors"
          />
        </motion.div>
      </motion.div>
    </div>
  );
};

export const Krisha2DFigure = KrishaAvatar;
export default KrishaAvatar;
