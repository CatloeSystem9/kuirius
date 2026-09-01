import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  X,
  HardDrive,
  FolderPlus,
  FilePlus,
  Search,
  ExternalLink,
  FileText,
  Code,
  Image,
  Music,
  Video,
  Database,
  FileQuestion,
  Sparkles,
  CheckCircle2,
  FolderTree,
  Folder,
  Layers,
  ChevronRight,
  Filter,
} from 'lucide-react';
import {
  LocalIndexedFile,
  IndexedFolder,
  pickAndAddFiles,
  pickAndAddDirectory,
  saveFilesToIndex,
  loadIndexedFiles,
  searchLocalFiles,
  openOrDownloadFile,
} from '../utils/fileSystemAccess';

interface LocalFilesModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectFile?: (file: LocalIndexedFile) => void;
  initialSearchQuery?: string;
  initialFolderFilter?: string;
}

export const LocalFilesModal: React.FC<LocalFilesModalProps> = ({
  isOpen,
  onClose,
  onSelectFile,
  initialSearchQuery = '',
  initialFolderFilter = 'ALL',
}) => {
  const [files, setFiles] = useState<LocalIndexedFile[]>([]);
  const [folders, setFolders] = useState<IndexedFolder[]>([]);
  const [searchQuery, setSearchQuery] = useState(initialSearchQuery);
  const [selectedFolder, setSelectedFolder] = useState<string>(initialFolderFilter);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [scanStatus, setScanStatus] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);

  // Load files & scanned folders when modal opens
  useEffect(() => {
    if (isOpen) {
      loadIndexedFiles().then(({ files: loadedFiles, folders: loadedFolders }) => {
        setFiles(loadedFiles);
        setFolders(loadedFolders);
        if (initialSearchQuery) setSearchQuery(initialSearchQuery);
        if (initialFolderFilter) setSelectedFolder(initialFolderFilter);
      });
    }
  }, [isOpen, initialSearchQuery, initialFolderFilter]);

  if (!isOpen) return null;

  // Compute unique folders present in files
  const availableFolderNames = Array.from(
    new Set(files.map((f) => f.folderName).filter((name) => Boolean(name) && name !== 'Root'))
  );

  // Filter files by query, folder, and category
  const filteredFiles = searchLocalFiles(searchQuery, selectedFolder === 'ALL' ? undefined : selectedFolder, files).filter((f) => {
    if (categoryFilter === 'ALL') return true;
    return f.category === categoryFilter;
  });

  const handleAddFiles = async () => {
    setIsLoading(true);
    try {
      const updated = await pickAndAddFiles();
      setFiles([...updated]);
      showNotification(`Added files from your computer storage.`);
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
    }
  };

  const handleScanDirectory = async () => {
    setIsLoading(true);
    setScanStatus('Scanning folder and subfolders...');
    try {
      const { files: updatedFiles, folder } = await pickAndAddDirectory((count, currentDir) => {
        setScanStatus(`Scanning ${currentDir} (${count} files indexed)...`);
      });

      setFiles([...updatedFiles]);
      if (folder) {
        setFolders((prev) => [folder, ...prev.filter((f) => f.name !== folder.name)]);
        setSelectedFolder(folder.name);
        showNotification(`Successfully scanned and indexed "${folder.name}" (${folder.fileCount} files).`);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setIsLoading(false);
      setScanStatus(null);
    }
  };

  const showNotification = (msg: string) => {
    setSuccessNotice(msg);
    setTimeout(() => setSuccessNotice(null), 3500);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      setIsLoading(true);
      const droppedFiles: File[] = Array.from(e.dataTransfer.files);
      const items = droppedFiles.map((f) => ({
        file: f,
        folderPath: 'Dropped Files',
        folderName: 'Dropped Files',
      }));
      const updated = await saveFilesToIndex(items);
      setFiles([...updated]);
      setIsLoading(false);
      showNotification(`Indexed ${droppedFiles.length} file(s).`);
    }
  };

  const handleOpenFile = (file: LocalIndexedFile) => {
    openOrDownloadFile(file);
    if (onSelectFile) onSelectFile(file);
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  const getFileIcon = (category: LocalIndexedFile['category']) => {
    switch (category) {
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

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
        {/* Backdrop */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
          className="absolute inset-0 bg-[#02040a]/85 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 10 }}
          transition={{ duration: 0.22 }}
          className="relative w-full max-w-3xl bg-[#050810] border border-blue-900/40 rounded-2xl shadow-[0_0_60px_rgba(0,0,0,0.85)] overflow-hidden flex flex-col max-h-[90vh] z-10 text-slate-200"
        >
          {/* Modal Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-blue-900/20 bg-[#080d1a]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <FolderTree className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-blue-100/90 flex items-center gap-2">
                  <span>Folder & Computer Storage Scanner</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-500/20 text-blue-300 font-mono">
                    {files.length} files • {folders.length} folders
                  </span>
                </h2>
                <p className="text-[11px] text-blue-400/50 mt-0.5 tracking-wide">
                  Scan multiple folders to let Krisha inspect, locate, and open any file for you
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              id="close-files-modal"
              className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Action Bar & Storage Selector */}
          <div className="p-4 border-b border-blue-900/20 flex flex-wrap items-center justify-between gap-3 bg-[#03060d]">
            {/* Search Input */}
            <div className="relative flex-1 min-w-[220px] flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search across all scanned folders and files..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#070b16] border border-blue-900/30 rounded-xl pl-9 pr-3.5 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/40 transition-colors"
              />
            </div>

            {/* Folder Scanner & File Picker Buttons */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={handleScanDirectory}
                disabled={isLoading}
                id="btn-scan-folder"
                className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-semibold tracking-wider uppercase transition-all shadow-[0_0_20px_rgba(37,99,235,0.35)] cursor-pointer"
                title="Scan and index any folder with subfolders"
              >
                <FolderPlus className="w-4 h-4 text-blue-200" />
                <span>Scan New Folder</span>
              </button>

              <button
                type="button"
                onClick={handleAddFiles}
                disabled={isLoading}
                id="btn-pick-local-files"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-blue-950/70 hover:bg-blue-900/50 border border-blue-700/40 text-blue-200 text-xs font-medium tracking-wider uppercase transition-all cursor-pointer"
                title="Select individual files from computer"
              >
                <FilePlus className="w-3.5 h-3.5" />
                <span>Add Files</span>
              </button>
            </div>
          </div>

          {/* Folder Filter Pill Strip */}
          {(availableFolderNames.length > 0 || folders.length > 0) && (
            <div className="px-4 py-2.5 border-b border-blue-900/20 bg-[#060a14] flex items-center gap-2 overflow-x-auto text-xs no-scrollbar">
              <span className="text-[10px] text-slate-500 uppercase tracking-wider flex items-center gap-1 shrink-0">
                <Folder className="w-3 h-3 text-blue-400" />
                Folders:
              </span>

              <button
                type="button"
                onClick={() => setSelectedFolder('ALL')}
                className={`px-2.5 py-1 rounded-lg text-[11px] font-medium shrink-0 transition-colors cursor-pointer ${
                  selectedFolder === 'ALL'
                    ? 'bg-blue-600 text-white'
                    : 'bg-blue-950/40 text-slate-400 hover:text-blue-300 hover:bg-blue-900/30'
                }`}
              >
                All Folders ({files.length})
              </button>

              {availableFolderNames.map((fName) => {
                const count = files.filter((f) => f.folderName === fName).length;
                return (
                  <button
                    key={fName}
                    type="button"
                    onClick={() => setSelectedFolder(fName)}
                    className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium shrink-0 transition-colors cursor-pointer ${
                      selectedFolder === fName
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'bg-blue-950/40 text-slate-400 hover:text-blue-300 hover:bg-blue-900/30 border border-blue-900/30'
                    }`}
                  >
                    <Folder className="w-3 h-3 text-blue-400" />
                    <span>{fName}</span>
                    <span className="text-[9px] opacity-75 font-mono">({count})</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Scanning Status Progress Banner */}
          {isLoading && scanStatus && (
            <div className="px-6 py-2.5 bg-blue-950/60 border-b border-blue-500/30 text-blue-300 text-xs flex items-center gap-2 animate-pulse">
              <Sparkles className="w-3.5 h-3.5 text-blue-400 animate-spin" />
              <span>{scanStatus}</span>
            </div>
          )}

          {/* Success / Alert Toast */}
          <AnimatePresence>
            {successNotice && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                className="px-6 py-2 bg-emerald-950/40 border-b border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2"
              >
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                <span>{successNotice}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Drag & Drop Surface & Files List */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={handleDrop}
            className={`flex-1 overflow-y-auto p-4 space-y-2 transition-colors ${
              isDragging ? 'bg-blue-950/30 border-2 border-dashed border-blue-500/60' : ''
            }`}
          >
            {files.length === 0 ? (
              <div className="py-16 px-6 text-center flex flex-col items-center justify-center">
                <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mb-3">
                  <FolderTree className="w-7 h-7 text-blue-400" />
                </div>
                <h3 className="text-sm font-semibold text-slate-200">No Folders or Files Scanned Yet</h3>
                <p className="text-xs text-slate-500 max-w-md mt-1.5 leading-relaxed">
                  Click <strong>"Scan New Folder"</strong> to select any folder from your computer (e.g. Documents, Downloads, Projects, Pictures). Krisha will scan subfolders, index every file, and locate them instantly when you ask.
                </p>
                <div className="mt-4 flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleScanDirectory}
                    className="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold uppercase tracking-wider transition-all shadow-[0_0_15px_rgba(37,99,235,0.3)] cursor-pointer"
                  >
                    Scan a Folder Now
                  </button>
                </div>
              </div>
            ) : filteredFiles.length === 0 ? (
              <div className="py-12 text-center text-slate-500 text-xs font-light">
                No matching files found for "{searchQuery}" {selectedFolder !== 'ALL' ? `in "${selectedFolder}"` : ''}.
              </div>
            ) : (
              filteredFiles.map((file) => (
                <div
                  key={file.id}
                  className="group flex items-center justify-between p-3.5 rounded-xl bg-[#060a14] border border-blue-900/20 hover:border-blue-700/40 hover:bg-[#0a1020] transition-all"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1 pr-3">
                    <div className="p-2 rounded-lg bg-blue-950/50 border border-blue-800/30 shrink-0">
                      {getFileIcon(file.category)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <h4 className="text-xs font-medium text-slate-200 truncate">{file.name}</h4>
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-950 border border-blue-800/40 text-blue-400 uppercase font-mono">
                          {file.extension || 'file'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-1 text-[10px] text-slate-500 font-mono">
                        <span className="text-blue-400/90 font-sans flex items-center gap-1">
                          <Folder className="w-2.5 h-2.5" />
                          {file.folderPath || file.folderName}
                        </span>
                        <span>•</span>
                        <span>{formatFileSize(file.size)}</span>
                        <span>•</span>
                        <span>{new Date(file.lastModified).toLocaleDateString()}</span>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleOpenFile(file)}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600/80 hover:bg-blue-600 text-white text-xs font-medium transition-all shadow-[0_0_10px_rgba(37,99,235,0.2)] cursor-pointer"
                      title="Open and view file"
                    >
                      <ExternalLink className="w-3.5 h-3.5" />
                      <span>Open</span>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Quick Voice Command Guide Footer */}
          <div className="px-6 py-3 bg-[#060a14] border-t border-blue-900/20 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <div className="flex items-center gap-2">
              <Sparkles className="w-3.5 h-3.5 text-blue-400 shrink-0" />
              <span>Voice commands: <em>"Krisha scan my Projects folder"</em> or <em>"check Documents for resume"</em></span>
            </div>
            <span className="font-mono text-[10px] text-blue-500/70">{filteredFiles.length} visible files</span>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
