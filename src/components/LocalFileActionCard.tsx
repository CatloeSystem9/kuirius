import React from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  HardDrive,
  FileText,
  Code,
  Image,
  Music,
  Video,
  Database,
  FileQuestion,
  ExternalLink,
  X,
  Sparkles,
  FolderSearch,
  Folder,
} from 'lucide-react';
import { LocalFileAction } from '../types';
import { openOrDownloadFile, LocalIndexedFile } from '../utils/fileSystemAccess';

interface LocalFileActionCardProps {
  action: LocalFileAction | null;
  onDismiss?: () => void;
  onOpenFilesModal?: () => void;
  onOpenFile?: (file: LocalIndexedFile) => void;
  isLightMode?: boolean;
}

export const LocalFileActionCard: React.FC<LocalFileActionCardProps> = ({
  action,
  onDismiss,
  onOpenFilesModal,
  onOpenFile,
  isLightMode = false,
}) => {
  if (!action) return null;

  const matched = action.matchedFiles || [];
  const topMatch = matched[0];
  const isScanFolder = action.type === 'scan_folder';
  const isPdf =
    topMatch?.extension?.toLowerCase() === 'pdf' ||
    topMatch?.name?.toLowerCase().endsWith('.pdf') ||
    topMatch?.category === 'document';

  const getFileIcon = (cat?: string, ext?: string) => {
    if (ext === 'pdf') {
      return <FileText className="w-4 h-4 text-rose-400" />;
    }
    switch (cat) {
      case 'code':
        return <Code className="w-4 h-4 text-emerald-400" />;
      case 'document':
        return <FileText className="w-4 h-4 text-blue-400" />;
      case 'image':
        return <Image className="w-4 h-4 text-rose-400" />;
      case 'audio':
        return <Music className="w-4 h-4 text-purple-400" />;
      case 'video':
        return <Video className="w-4 h-4 text-amber-400" />;
      case 'data':
        return <Database className="w-4 h-4 text-cyan-400" />;
      default:
        return <FileQuestion className="w-4 h-4 text-slate-400" />;
    }
  };

  const handleOpenTopMatch = () => {
    if (topMatch) {
      if (onOpenFile) {
        onOpenFile(topMatch as unknown as LocalIndexedFile);
      } else {
        openOrDownloadFile(topMatch as unknown as LocalIndexedFile);
      }
    } else if (onOpenFilesModal) {
      onOpenFilesModal();
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 10, scale: 0.96 }}
        transition={{ duration: 0.3, ease: 'easeOut' }}
        className={`w-full max-w-xl mx-auto mb-2.5 px-3.5 py-2.5 rounded-2xl backdrop-blur-xl border flex items-center justify-between gap-3 shadow-xl pointer-events-auto transition-all ${
          isLightMode
            ? 'bg-white/95 border-slate-200 text-slate-800 shadow-[0_10px_30px_rgba(0,0,0,0.08)]'
            : 'bg-[#090e1f]/95 border-blue-500/35 text-slate-200 shadow-[0_0_35px_rgba(30,58,138,0.35)]'
        }`}
      >
        {/* Left icon & details */}
        <div className="flex items-center gap-2.5 min-w-0 flex-1">
          <div
            className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${
              isLightMode
                ? 'bg-slate-100 border border-slate-200/80 shadow-sm'
                : 'bg-[#101833] border border-blue-500/30'
            }`}
          >
            {isScanFolder ? (
              <Folder className="w-4 h-4 text-blue-400" />
            ) : topMatch ? (
              getFileIcon(topMatch.category)
            ) : (
              <HardDrive className="w-4 h-4 text-blue-400" />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] font-medium tracking-wide uppercase flex items-center gap-1 text-blue-400">
                <Sparkles className="w-2.5 h-2.5 text-blue-400 animate-pulse" />
                {isScanFolder
                  ? action.folderName
                    ? `Scanning folder "${action.folderName}"`
                    : `Scanning folders`
                  : matched.length > 0
                  ? `Found file in storage`
                  : `Checking computer folders`}
              </span>
            </div>

            {topMatch ? (
              <div className="flex items-center gap-2 mt-0.5">
                <p
                  className={`text-xs font-semibold truncate ${
                    isLightMode ? 'text-slate-900' : 'text-blue-50'
                  }`}
                  title={topMatch.name}
                >
                  {topMatch.name}
                </p>
                {topMatch.folderName && (
                  <span className="text-[10px] text-slate-400 font-mono flex items-center gap-0.5">
                    <Folder className="w-2.5 h-2.5" />
                    {topMatch.folderName}
                  </span>
                )}
              </div>
            ) : action.query ? (
              <p
                className={`text-[11px] truncate mt-0.5 ${
                  isLightMode ? 'text-slate-500' : 'text-blue-300/70 font-mono'
                }`}
              >
                Checking for: "{action.query}"
              </p>
            ) : (
              <p className="text-[11px] text-slate-400">Computer folder scanner</p>
            )}
          </div>
        </div>

        {/* Right Action buttons */}
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {topMatch ? (
            <button
              type="button"
              onClick={handleOpenTopMatch}
              className={`flex items-center gap-1 px-3.5 py-1.5 rounded-xl text-[11px] font-semibold text-white shadow-md transition-all cursor-pointer ${
                isPdf
                  ? 'bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 shadow-rose-500/25'
                  : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 shadow-blue-500/25'
              }`}
            >
              <FileText className="w-3.5 h-3.5" />
              <span>{isPdf ? 'Read PDF' : 'Open File'}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={onOpenFilesModal}
              className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-[11px] font-medium bg-blue-600 hover:bg-blue-500 text-white transition-all cursor-pointer"
            >
              <FolderSearch className="w-3.5 h-3.5" />
              <span>Scan Folders</span>
            </button>
          )}

          {onDismiss && (
            <button
              onClick={onDismiss}
              className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                isLightMode
                  ? 'text-slate-400 hover:text-slate-700 hover:bg-slate-100'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-blue-950/50'
              }`}
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
