/**
 * Camera Vision Panel (Step 6) — the explicit, visible camera surface.
 *
 * Renders ONLY while the camera is active/starting: the live preview, the
 * camera-active indicator, the immediate stop control, and the "Ask about
 * this" action. When the camera is off, this component renders nothing —
 * the application never shows a camera surface implicitly.
 */
import { useEffect, useRef } from 'react';
import { Camera, X, Eye } from 'lucide-react';
import type { CameraStatus } from '../utils/cameraVision';

export interface CameraVisionPanelProps {
  status: CameraStatus;
  /** Bind the preview <video> element to the service. */
  onVideoRef: (el: HTMLVideoElement | null) => void;
  onStop: () => void;
  onAsk: () => void;
  asking: boolean;
}

const STATUS_LABEL: Record<CameraStatus, string> = {
  inactive: 'Camera off',
  starting: 'Starting camera…',
  active: 'Camera active',
  permission_denied: 'Camera permission denied',
  camera_unavailable: 'Camera unavailable',
  camera_disconnected: 'Camera disconnected',
  failed: 'Camera error',
};

export const CameraVisionPanel: React.FC<CameraVisionPanelProps> = ({ status, onVideoRef, onStop, onAsk, asking }) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    onVideoRef(videoRef.current);
    return () => onVideoRef(null);
  }, [onVideoRef]);

  if (status !== 'active' && status !== 'starting') return null;
  const isActive = status === 'active';

  return (
    <div className="fixed bottom-4 right-4 z-40 w-56 rounded-2xl border border-blue-900/40 bg-[#050810]/95 shadow-[0_0_30px_rgba(0,0,0,0.7)] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-blue-900/30 bg-[#080d1a]">
        <div className="flex items-center gap-1.5">
          <Camera className="w-3.5 h-3.5 text-blue-400" />
          <span className="text-[10px] font-semibold tracking-wider uppercase text-blue-100/90">Camera Vision</span>
        </div>
        {/* Camera-active indicator: always visible while the camera is on. */}
        <span
          className={`w-2 h-2 rounded-full ${isActive ? 'bg-red-500 animate-pulse shadow-[0_0_8px_rgba(239,68,68,0.8)]' : 'bg-yellow-500 animate-pulse'}`}
          title={isActive ? 'Camera is active' : 'Starting'}
        />
      </div>
      <div className="relative bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className={`w-full aspect-video object-cover ${isActive ? 'opacity-100' : 'opacity-40'}`}
        />
        {!isActive && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] text-slate-400">
            {STATUS_LABEL[status]}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2 bg-[#080d1a]">
        <span className="text-[9px] text-blue-400/60">{STATUS_LABEL[status]}</span>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAsk}
            disabled={!isActive || asking}
            className="px-2 py-1 rounded-lg bg-blue-950/40 hover:bg-blue-900/40 border border-blue-800/40 rounded-lg text-[10px] text-blue-200 flex items-center gap-1 transition-colors disabled:opacity-40 cursor-pointer disabled:cursor-not-allowed"
            title="Capture one frame and ask Krix what she sees"
          >
            <Eye className="w-3 h-3" />
            <span>{asking ? 'Looking…' : 'Ask Krix'}</span>
          </button>
          <button
            type="button"
            onClick={onStop}
            className="p-1.5 rounded-lg bg-rose-950/40 hover:bg-rose-900/50 border border-rose-800/40 text-rose-300 transition-colors cursor-pointer"
            title="Stop the camera immediately"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>
    </div>
  );
};
