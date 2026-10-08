import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  ExternalLink,
  Download,
  FileText,
  Code,
  Image as ImageIcon,
  Music,
  Video,
  Database,
  Sparkles,
  Folder,
  Maximize2,
  Minimize2,
  Copy,
  Check,
  ZoomIn,
  ZoomOut,
  Upload,
  LayoutTemplate,
  FileCode,
} from 'lucide-react';
import { LocalIndexedFile, openOrDownloadFile, pickAndAddFiles } from '../utils/fileSystemAccess';

interface DocumentViewerModalProps {
  file: LocalIndexedFile | null;
  isOpen: boolean;
  onClose: () => void;
  onSelectAnotherFile?: (file: LocalIndexedFile) => void;
  availableFiles?: LocalIndexedFile[];
  onUploadNewFile?: (file: LocalIndexedFile) => void;
}

export const DocumentViewerModal: React.FC<DocumentViewerModalProps> = ({
  file,
  isOpen,
  onClose,
  onSelectAnotherFile,
  availableFiles = [],
  onUploadNewFile,
}) => {
  const [copied, setCopied] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [zoomLevel, setZoomLevel] = useState(100);
  const [viewMode, setViewMode] = useState<'formatted' | 'embedded' | 'text'>(
    file?.extension.toLowerCase() === 'pdf' ? 'embedded' : 'formatted'
  );
  const [isUploading, setIsUploading] = useState(false);

  useEffect(() => {
    if (file) {
      const isPdfDoc =
        file.extension.toLowerCase() === 'pdf' ||
        file.type === 'application/pdf' ||
        file.name.toLowerCase().endsWith('.pdf');
      setViewMode(isPdfDoc ? 'embedded' : 'formatted');
    }
  }, [file]);

  const activeBlobUrl = React.useMemo(() => {
    if (!file) return null;
    if (file.blobUrl) return file.blobUrl;
    if (file.fileRef instanceof Blob) {
      try {
        return URL.createObjectURL(file.fileRef);
      } catch {
        return null;
      }
    }
    return null;
  }, [file]);

  if (!isOpen || !file) return null;

  const isPdf =
    file.extension.toLowerCase() === 'pdf' ||
    file.type === 'application/pdf' ||
    file.name.toLowerCase().endsWith('.pdf');

  const isImage =
    ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'].includes(file.extension.toLowerCase()) ||
    file.type.startsWith('image/');

  const isTextOrCode =
    ['txt', 'md', 'json', 'ts', 'tsx', 'js', 'jsx', 'py', 'css', 'html', 'yaml', 'yml', 'sh', 'sql', 'csv'].includes(
      file.extension.toLowerCase()
    ) ||
    file.category === 'code' ||
    file.category === 'document';

  const formatFileSize = (bytes: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const handleCopyContent = () => {
    const textToCopy = file.previewText || file.name;
    navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleExternalOpen = () => {
    openOrDownloadFile(file);
  };

  const handlePickLocalPdf = async () => {
    setIsUploading(true);
    try {
      const added = await pickAndAddFiles();
      if (added.length > 0) {
        const newest = added[added.length - 1];
        if (onSelectAnotherFile) onSelectAnotherFile(newest);
        if (onUploadNewFile) onUploadNewFile(newest);
      }
    } catch (e) {
      console.warn('File pick error:', e);
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 md:p-6">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-[#02040a]/90 backdrop-blur-md"
        />

        {/* Viewer Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ duration: 0.24, ease: 'easeOut' }}
          className={`relative w-full ${
            isFullscreen ? 'max-w-[98vw] h-[96vh]' : 'max-w-4xl h-[90vh]'
          } bg-[#060a15] border border-blue-500/30 rounded-2xl shadow-[0_0_80px_rgba(0,0,0,0.95)] overflow-hidden flex flex-col z-10 text-slate-200 transition-all duration-300`}
        >
          {/* Top Title Bar */}
          <div className="flex items-center justify-between px-4 sm:px-5 py-3 border-b border-blue-900/30 bg-[#090f20]">
            <div className="flex items-center gap-3 min-w-0 flex-1 mr-3">
              <div className="p-2 rounded-xl bg-blue-500/15 border border-blue-400/30 text-blue-400 shrink-0">
                {isPdf ? (
                  <FileText className="w-5 h-5 text-rose-400" />
                ) : isImage ? (
                  <ImageIcon className="w-5 h-5 text-emerald-400" />
                ) : (
                  <FileText className="w-5 h-5 text-blue-400" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h2 className="text-sm font-semibold text-slate-100 truncate" title={file.name}>
                    {file.name}
                  </h2>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full font-mono uppercase font-bold tracking-wider ${
                      isPdf
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                        : 'bg-blue-500/20 text-blue-300 border border-blue-500/30'
                    }`}
                  >
                    {file.extension || 'file'}
                  </span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/20 flex items-center gap-1">
                    <Sparkles className="w-2.5 h-2.5" />
                    <span>Opened by Krisha</span>
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5 text-[11px] text-slate-400">
                  <span className="flex items-center gap-1 font-mono text-blue-400/80">
                    <Folder className="w-3 h-3" />
                    {file.folderPath || file.folderName}
                  </span>
                  <span>•</span>
                  <span>{formatFileSize(file.size)}</span>
                  <span>•</span>
                  <span>{new Date(file.lastModified).toLocaleDateString()}</span>
                </div>
              </div>
            </div>

            {/* Viewer Controls */}
            <div className="flex items-center gap-1.5 shrink-0">
              {/* Text/Code View Mode Tabs */}
              {!isPdf && isTextOrCode && (
                <div className="hidden sm:flex items-center gap-1 bg-blue-950/60 p-0.5 rounded-lg border border-blue-900/40 text-xs mr-1">
                  <button
                    type="button"
                    onClick={() => setViewMode('formatted')}
                    className={`px-2 py-1 rounded-md transition-colors flex items-center gap-1 ${
                      viewMode === 'formatted'
                        ? 'bg-blue-600 text-white font-medium shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <LayoutTemplate className="w-3 h-3" />
                    <span>Formatted</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode('text')}
                    className={`px-2 py-1 rounded-md transition-colors flex items-center gap-1 ${
                      viewMode === 'text'
                        ? 'bg-blue-600 text-white font-medium shadow-sm'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <FileCode className="w-3 h-3" />
                    <span>Raw Text</span>
                  </button>
                </div>
              )}

              {/* Zoom Controls */}
              <div className="hidden md:flex items-center gap-1 mr-1 px-2 py-1 rounded-lg bg-blue-950/60 border border-blue-900/40 text-slate-300 text-xs">
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.max(60, z - 15))}
                  className="p-1 hover:text-blue-400 transition-colors"
                  title="Zoom Out"
                >
                  <ZoomOut className="w-3.5 h-3.5" />
                </button>
                <span className="px-1 text-[10px] font-mono">{zoomLevel}%</span>
                <button
                  type="button"
                  onClick={() => setZoomLevel((z) => Math.min(180, z + 15))}
                  className="p-1 hover:text-blue-400 transition-colors"
                  title="Zoom In"
                >
                  <ZoomIn className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Upload Another PDF from Device */}
              <button
                type="button"
                onClick={handlePickLocalPdf}
                disabled={isUploading}
                className="hidden sm:flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-950/60 hover:bg-blue-900/50 border border-blue-800/40 text-blue-300 text-xs transition-colors cursor-pointer"
                title="Pick and open a PDF from your computer"
              >
                <Upload className="w-3.5 h-3.5 text-blue-400" />
                <span>Upload PDF</span>
              </button>

              {file.previewText && (
                <button
                  type="button"
                  onClick={handleCopyContent}
                  className="p-2 text-slate-400 hover:text-blue-300 hover:bg-blue-950/60 rounded-lg transition-colors cursor-pointer"
                  title="Copy text content"
                >
                  {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
                </button>
              )}

              <button
                type="button"
                onClick={() => setIsFullscreen(!isFullscreen)}
                className="p-2 text-slate-400 hover:text-blue-300 hover:bg-blue-950/60 rounded-lg transition-colors cursor-pointer"
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>

              <button
                type="button"
                onClick={handleExternalOpen}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold tracking-wide transition-all shadow-[0_0_15px_rgba(37,99,235,0.3)] cursor-pointer"
                title="Open in new browser window / Download"
              >
                <ExternalLink className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Open in Tab</span>
              </button>

              <button
                type="button"
                onClick={onClose}
                className="p-2 text-slate-400 hover:text-slate-100 hover:bg-slate-800/60 rounded-lg transition-colors cursor-pointer ml-1"
                title="Close Document"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Document Content Canvas */}
          <div className="flex-1 overflow-y-auto relative bg-[#02050c] flex flex-col items-center justify-start p-4 sm:p-6 md:p-8">
            {isPdf ? (
              activeBlobUrl ? (
                <div
                  className="w-full h-full min-h-[520px] border border-blue-900/40 bg-slate-900 rounded-xl shadow-2xl overflow-hidden flex flex-col"
                  style={{ transform: `scale(${zoomLevel / 100})`, transformOrigin: 'top center' }}
                >
                  <object
                    data={`${activeBlobUrl}#toolbar=1&navpanes=0`}
                    type="application/pdf"
                    className="w-full h-full min-h-[580px] flex-1"
                  >
                    <iframe
                      src={`${activeBlobUrl}#zoom=${zoomLevel}`}
                      title={file.name}
                      className="w-full h-full min-h-[580px] border-0 bg-white"
                    />
                  </object>
                </div>
              ) : (
                <div className="w-full max-w-lg bg-[#080d1e] border border-blue-900/40 rounded-2xl p-8 text-center flex flex-col items-center justify-center shadow-2xl my-auto">
                  <div className="w-16 h-16 rounded-2xl bg-rose-500/10 border border-rose-500/25 flex items-center justify-center mb-4 text-rose-400">
                    <FileText className="w-8 h-8" />
                  </div>
                  <span className="text-[10px] font-bold tracking-widest text-rose-500 uppercase font-mono mb-1">
                    PDF Document
                  </span>
                  <h2 className="text-base font-bold text-slate-100 mb-1">{file.name}</h2>
                  <p className="text-xs text-slate-400 mb-6 font-mono">
                    Location: {file.folderPath || file.folderName} • Size: {formatFileSize(file.size)}
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-3">
                    <button
                      type="button"
                      onClick={handleExternalOpen}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-rose-600 to-pink-600 hover:from-rose-500 hover:to-pink-500 text-white text-xs font-semibold uppercase tracking-wider transition-all shadow-lg shadow-rose-600/25 cursor-pointer"
                    >
                      <ExternalLink className="w-4 h-4" />
                      <span>Open PDF in Browser Tab</span>
                    </button>
                    <button
                      type="button"
                      onClick={handlePickLocalPdf}
                      className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-blue-950/80 hover:bg-blue-900 border border-blue-800/40 text-blue-200 text-xs font-semibold uppercase tracking-wider transition-all cursor-pointer"
                    >
                      <Upload className="w-4 h-4" />
                      <span>Choose / Upload PDF</span>
                    </button>
                  </div>
                </div>
              )
            ) : isImage && file.blobUrl ? (
              <div className="w-full h-full flex items-center justify-center p-4 overflow-auto">
                <img
                  src={file.blobUrl}
                  alt={file.name}
                  className="max-w-full max-h-full object-contain rounded-lg shadow-2xl transition-transform"
                  style={{ transform: `scale(${zoomLevel / 100})` }}
                />
              </div>
            ) : isTextOrCode && file.previewText ? (
              <div className="w-full max-w-3xl overflow-y-auto p-6 font-mono text-xs text-slate-200 leading-relaxed bg-[#03060f] border border-blue-900/40 rounded-xl shadow-2xl">
                <pre className="whitespace-pre-wrap break-words">{file.previewText}</pre>
              </div>
            ) : (
              <div className="p-8 text-center max-w-md my-auto">
                <FileText className="w-12 h-12 text-blue-400 mx-auto mb-3" />
                <h3 className="text-sm font-semibold text-slate-200">{file.name}</h3>
                <p className="text-xs text-slate-400 mt-1">Binary file ({formatFileSize(file.size)})</p>
                <button
                  type="button"
                  onClick={handleExternalOpen}
                  className="mt-4 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold flex items-center gap-2 mx-auto cursor-pointer"
                >
                  <Download className="w-4 h-4" />
                  <span>Download / Open with Default App</span>
                </button>
              </div>
            )}
          </div>

          {/* Quick File Switcher Bottom Bar */}
          {availableFiles.length > 1 && (
            <div className="px-4 py-2.5 border-t border-blue-900/20 bg-[#080d1c] flex items-center justify-between gap-2 overflow-x-auto text-xs no-scrollbar">
              <div className="flex items-center gap-2 overflow-x-auto">
                <span className="text-[10px] text-slate-500 uppercase tracking-wider shrink-0 font-medium">
                  Available Documents:
                </span>
                {availableFiles
                  .filter((f) => f.id !== file.id)
                  .slice(0, 8)
                  .map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => onSelectAnotherFile && onSelectAnotherFile(f)}
                      className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-blue-950/40 hover:bg-blue-900/40 border border-blue-900/30 text-[11px] text-slate-300 hover:text-blue-300 transition-colors shrink-0 cursor-pointer"
                    >
                      <FileText
                        className={`w-3 h-3 ${f.extension === 'pdf' ? 'text-rose-400' : 'text-blue-400'}`}
                      />
                      <span className="truncate max-w-[140px]">{f.name}</span>
                    </button>
                  ))}
              </div>

              <button
                type="button"
                onClick={handlePickLocalPdf}
                className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-blue-600/20 hover:bg-blue-600/30 border border-blue-500/30 text-blue-300 text-[11px] shrink-0 cursor-pointer transition-colors"
              >
                <Upload className="w-3 h-3 text-blue-400" />
                <span>Add More PDFs</span>
              </button>
            </div>
          )}
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
