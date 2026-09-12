/**
 * Local File System & Document Bridge
 * Enables Krisha to search, index, scan directories/folders recursively,
 * preview, and open files from the user's computer storage.
 * Uses modern File System Access API with IndexedDB caching & folder hierarchy tracking.
 */

export interface IndexedFolder {
  id: string;
  name: string;
  path: string;
  fileCount: number;
  addedAt: number;
  handle?: any; // FileSystemDirectoryHandle
}

export interface LocalIndexedFile {
  id: string;
  name: string;
  folderPath: string; // e.g. "Documents/Projects/App"
  folderName: string;
  size: number;
  type: string;
  lastModified: number;
  extension: string;
  category: 'code' | 'document' | 'image' | 'audio' | 'video' | 'data' | 'other';
  previewText?: string;
  blobUrl?: string;
  handle?: any; // FileSystemFileHandle if supported
  fileRef?: File;
}

const DB_NAME = 'KrishaLocalFilesDB';
const DB_VERSION = 2;
const STORE_FILES = 'indexed_files';
const STORE_FOLDERS = 'indexed_folders';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !window.indexedDB) {
      reject(new Error('IndexedDB not supported'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e: any) => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_FILES)) {
        db.createObjectStore(STORE_FILES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_FOLDERS)) {
        db.createObjectStore(STORE_FOLDERS, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

const PLAIN_TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'tex', 'log', 'csv', 'tsv', 'xml',
  'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'cpp', 'c', 'cs',
  'html', 'css', 'scss', 'json', 'yaml', 'yml', 'rs', 'go',
  'sh', 'sql', 'php', 'rb', 'kt', 'swift',
]);

function isPlainTextFile(fileName: string, mimeType: string): boolean {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  return PLAIN_TEXT_EXTENSIONS.has(ext) || mimeType.startsWith('text/');
}

export function detectFileCategory(fileName: string, mimeType: string): LocalIndexedFile['category'] {
  const ext = (fileName.split('.').pop() || '').toLowerCase();

  if (['ts', 'tsx', 'js', 'jsx', 'py', 'java', 'cpp', 'c', 'cs', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'rs', 'go', 'sh', 'sql', 'php', 'rb', 'kt', 'swift'].includes(ext)) {
    return 'code';
  }
  if (['txt', 'md', 'pdf', 'doc', 'docx', 'rtf', 'odt', 'tex', 'log', 'pages'].includes(ext) || mimeType.startsWith('text/')) {
    return 'document';
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'tiff'].includes(ext) || mimeType.startsWith('image/')) {
    return 'image';
  }
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma'].includes(ext) || mimeType.startsWith('audio/')) {
    return 'audio';
  }
  if (['mp4', 'webm', 'mov', 'mkv', 'avi', 'wmv'].includes(ext) || mimeType.startsWith('video/')) {
    return 'video';
  }
  if (['csv', 'xlsx', 'xls', 'tsv', 'parquet', 'xml', 'sqlite', 'db'].includes(ext)) {
    return 'data';
  }
  return 'other';
}

// In-memory memory bank for fast matching
let memoryFilesCache: LocalIndexedFile[] = [];
let memoryFoldersCache: IndexedFolder[] = [];

/**
 * Save files to persistent IndexedDB with folder path tracking
 */
export async function saveFilesToIndex(
  files: { file: File; folderPath?: string; folderName?: string }[]
): Promise<LocalIndexedFile[]> {
  const newIndexed: LocalIndexedFile[] = [];

  for (const item of files) {
    const file = item.file;
    const folderPath = item.folderPath || 'Root';
    const folderName = item.folderName || 'Root';
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const category = detectFileCategory(file.name, file.type);
    let previewText: string | undefined = undefined;

    // Only decode genuinely plain-text files. Never call .text() on
    // PDFs, Office documents, archives, databases, or other binary formats.
    if (isPlainTextFile(file.name, file.type)) {
      try {
        const text = await file.slice(0, 50000).text();
        previewText = text;
      } catch {}
    }

    const blobUrl = URL.createObjectURL(file);
    const indexedItem: LocalIndexedFile = {
      id: 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      name: file.name,
      folderPath,
      folderName,
      size: file.size,
      type: file.type || 'application/octet-stream',
      lastModified: file.lastModified,
      extension: ext,
      category,
      previewText,
      blobUrl,
      fileRef: file,
    };

    newIndexed.push(indexedItem);
  }

  // Prepend to in-memory cache
  memoryFilesCache = [...newIndexed, ...memoryFilesCache];

  // Persist metadata in IndexedDB
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_FILES, 'readwrite');
    const store = tx.objectStore(STORE_FILES);
    for (const item of newIndexed) {
      const record = { ...item, blobUrl: undefined };
      // IndexedDB can persist File/Blob objects through structured cloning.
      store.put(record);
    }
  } catch (e) {
    console.debug('IDB persist note:', e);
  }

  return memoryFilesCache;
}

/**
 * Save scanned folder metadata
 */
export async function saveFolderToIndex(folder: IndexedFolder): Promise<IndexedFolder[]> {
  memoryFoldersCache = [folder, ...memoryFoldersCache.filter((f) => f.name !== folder.name)];
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_FOLDERS, 'readwrite');
    const store = tx.objectStore(STORE_FOLDERS);
    store.put(folder);
  } catch {}
  return memoryFoldersCache;
}

/**
 * Load existing cached files and folders from storage
 */
export async function loadIndexedFiles(): Promise<{ files: LocalIndexedFile[]; folders: IndexedFolder[] }> {
  try {
    const db = await openDB();
    const tx = db.transaction([STORE_FILES, STORE_FOLDERS], 'readonly');
    const filesStore = tx.objectStore(STORE_FILES);
    const foldersStore = tx.objectStore(STORE_FOLDERS);

    const filesRequest = filesStore.getAll();
    const foldersRequest = foldersStore.getAll();

    return new Promise((resolve) => {
      tx.oncomplete = () => {
        const storedFiles = (filesRequest.result as LocalIndexedFile[]) || [];
        const folders = (foldersRequest.result as IndexedFolder[]) || [];

        // blob: URLs are page-session scoped, so recreate them from the
        // persisted File object after a reload when possible.
        const files = storedFiles.map((file) => {
          if (file.fileRef instanceof Blob) {
            try {
              return { ...file, blobUrl: URL.createObjectURL(file.fileRef) };
            } catch {}
          }

          // Old records may contain a binary preview generated by the buggy
          // implementation. Never treat that preview as a real binary file.
          if (!isPlainTextFile(file.name, file.type)) {
            return { ...file, previewText: undefined, blobUrl: undefined };
          }

          return file;
        });

        memoryFilesCache = files;
        memoryFoldersCache = folders;
        resolve({ files, folders });
      };
      tx.onerror = () => {
        resolve({ files: memoryFilesCache, folders: memoryFoldersCache });
      };
    });
  } catch {
    return { files: memoryFilesCache, folders: memoryFoldersCache };
  }
}

/**
 * Search local indexed files by keyword, extension, folder name, or deep content text
 */
export function searchLocalFiles(
  query: string,
  folderFilter?: string,
  filesList: LocalIndexedFile[] = memoryFilesCache
): LocalIndexedFile[] {
  let list = filesList;
  if (folderFilter && folderFilter !== 'ALL') {
    list = list.filter(
      (f) => f.folderName.toLowerCase() === folderFilter.toLowerCase() || f.folderPath.toLowerCase().includes(folderFilter.toLowerCase())
    );
  }

  const clean = query.trim().toLowerCase();
  if (!clean) return list;

  // Filter out stop words
  const words = clean
    .replace(/[^\w\s.-]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 0 &&
        ![
          'file',
          'files',
          'open',
          'search',
          'scan',
          'check',
          'find',
          'from',
          'my',
          'computer',
          'memory',
          'show',
          'the',
          'named',
          'called',
          'folder',
          'directory',
        ].includes(w)
    );

  if (words.length === 0) {
    return list;
  }

  return list.filter((f) => {
    const nameMatch = words.some((w) => f.name.toLowerCase().includes(w));
    const folderMatch = words.some((w) => f.folderName.toLowerCase().includes(w) || f.folderPath.toLowerCase().includes(w));
    const extMatch = words.some((w) => f.extension.toLowerCase() === w || `.${f.extension.toLowerCase()}` === w);
    const contentMatch = f.previewText ? words.some((w) => f.previewText!.toLowerCase().includes(w)) : false;
    return nameMatch || folderMatch || extMatch || contentMatch;
  });
}

/**
 * Trigger Native File System Open Picker (allows selecting any file from computer storage)
 */
export async function pickAndAddFiles(): Promise<LocalIndexedFile[]> {
  if (typeof window === 'undefined') return [];

  // Check for native File System Access API
  if ('showOpenFilePicker' in window) {
    try {
      const handles = await (window as any).showOpenFilePicker({
        multiple: true,
      });
      const items: { file: File; folderPath: string; folderName: string }[] = [];
      for (const h of handles) {
        const file = await h.getFile();
        items.push({ file, folderPath: 'Selected Files', folderName: 'Selected Files' });
      }
      return await saveFilesToIndex(items);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        return memoryFilesCache;
      }
    }
  }

  // Fallback to standard input element
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async () => {
      if (input.files && input.files.length > 0) {
        const items = Array.from(input.files).map((f) => ({
          file: f,
          folderPath: 'Uploads',
          folderName: 'Uploads',
        }));
        const result = await saveFilesToIndex(items);
        resolve(result);
      } else {
        resolve(memoryFilesCache);
      }
    };
    input.click();
  });
}

/**
 * Scan and deep-index an entire directory / folder from computer with subfolder recursion
 */
export async function pickAndAddDirectory(
  onProgress?: (scannedCount: number, currentFolder: string) => void
): Promise<{ files: LocalIndexedFile[]; folder: IndexedFolder | null }> {
  if (typeof window === 'undefined') return { files: [], folder: null };

  if ('showDirectoryPicker' in window) {
    try {
      const dirHandle = await (window as any).showDirectoryPicker();
      const folderRootName = dirHandle.name || 'Scanned Folder';
      const collected: { file: File; folderPath: string; folderName: string }[] = [];

      async function scanEntries(dir: any, currentPath: string, depth = 0) {
        if (depth > 6) return; // Support deep nesting up to 6 folders
        for await (const entry of dir.values()) {
          if (entry.kind === 'file') {
            try {
              const file = await entry.getFile();
              if (!file.name.startsWith('.') && file.size < 60 * 1024 * 1024) {
                collected.push({
                  file,
                  folderPath: currentPath,
                  folderName: dir.name || folderRootName,
                });
                if (onProgress) onProgress(collected.length, currentPath);
              }
            } catch {}
          } else if (
            entry.kind === 'directory' &&
            !entry.name.startsWith('.') &&
            !['node_modules', '.git', 'dist', 'build', '.next'].includes(entry.name)
          ) {
            await scanEntries(entry, `${currentPath}/${entry.name}`, depth + 1);
          }
        }
      }

      await scanEntries(dirHandle, folderRootName);

      if (collected.length > 0) {
        const updatedFiles = await saveFilesToIndex(collected);
        const folderMeta: IndexedFolder = {
          id: 'folder_' + Date.now(),
          name: folderRootName,
          path: folderRootName,
          fileCount: collected.length,
          addedAt: Date.now(),
        };
        await saveFolderToIndex(folderMeta);
        return { files: updatedFiles, folder: folderMeta };
      }
    } catch (err: any) {
      if (err.name === 'AbortError') return { files: memoryFilesCache, folder: null };
    }
  }

  // Fallback webkitdirectory folder picker
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    (input as any).webkitdirectory = true;
    input.multiple = true;
    input.onchange = async () => {
      if (input.files && input.files.length > 0) {
        const filesArr = Array.from(input.files);
        const rootFolder = filesArr[0]?.webkitRelativePath?.split('/')[0] || 'Scanned Folder';
        const items = filesArr.map((f) => {
          const pathParts = (f.webkitRelativePath || f.name).split('/');
          pathParts.pop();
          const folderPath = pathParts.join('/') || rootFolder;
          const folderName = pathParts[pathParts.length - 1] || rootFolder;
          return {
            file: f,
            folderPath,
            folderName,
          };
        });

        const updated = await saveFilesToIndex(items);
        const folderMeta: IndexedFolder = {
          id: 'folder_' + Date.now(),
          name: rootFolder,
          path: rootFolder,
          fileCount: items.length,
          addedAt: Date.now(),
        };
        await saveFolderToIndex(folderMeta);
        resolve({ files: updated, folder: folderMeta });
      } else {
        resolve({ files: memoryFilesCache, folder: null });
      }
    };
    input.click();
  });
}

/**
 * Open or download a file from computer storage
 */
export function openOrDownloadFile(file: LocalIndexedFile): void {
  if (typeof window === 'undefined') return;

  let url = file.blobUrl;

  // Rebuild a valid object URL from the real persisted file bytes if needed.
  if (!url && file.fileRef instanceof Blob) {
    try {
      url = URL.createObjectURL(file.fileRef);
    } catch {}
  }

  if (url) {
    const newTab = window.open(url, '_blank');
    if (!newTab) {
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.target = '_blank';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    return;
  }

  // Only synthesize a Blob from previewText for genuine text files.
  // Never reconstruct binary files (especially PDFs) from decoded text.
  if (file.previewText && isPlainTextFile(file.name, file.type)) {
    const blob = new Blob([file.previewText], { type: file.type || 'text/plain' });
    const previewUrl = URL.createObjectURL(blob);
    window.open(previewUrl, '_blank');
  }
}

/**
 * Detect file & folder scanning commands from user voice or text input
 */
export function parseFileCommand(text: string): {
  isFileCommand: boolean;
  targetQuery: string | null;
  targetFolder: string | null;
  action: 'search' | 'open' | 'scan_folder' | 'list_folders';
} {
  const clean = text.trim();

  // Folder scanning specific commands:
  // e.g. "scan my downloads folder", "scan folder documents", "check my projects folder for app.tsx"
  const scanFolderRegex = /\b(?:scan|check|search|look\s+in|index|inspect)\s+(?:in\s+|through\s+|my\s+)?(?:the\s+)?([a-z0-9_\-\s]+?)\s+(?:folder|directory)(?:\s+(?:for|to\s+check\s+for|named|looking\s+for)\s*(.+))?/i;
  const matchFolder = clean.match(scanFolderRegex);
  if (matchFolder) {
    const folderName = matchFolder[1].trim();
    const query = matchFolder[2] ? matchFolder[2].trim() : null;
    return {
      isFileCommand: true,
      targetQuery: query,
      targetFolder: folderName,
      action: 'scan_folder',
    };
  }

  // General folder command: "scan folders", "scan different folders"
  const generalScanFolderRegex = /\b(?:scan|check|search|index)\s+(?:diffrent|different|all|my|other)?\s*(?:folders|directories)\b/i;
  if (generalScanFolderRegex.test(clean)) {
    return {
      isFileCommand: true,
      targetQuery: null,
      targetFolder: null,
      action: 'scan_folder',
    };
  }

  // Direct file with extension: e.g. "open resume.pdf", "open document.pdf", "view notes.txt"
  const directFileWithExtRegex = /\b(?:open|show|view|get|pull\s+up|load)\s+(?:a\s+|the\s+|my\s+)?([a-z0-9_\-\s]+\.(?:pdf|txt|md|docx?|json|js|ts|tsx|py|csv|png|jpe?g|webp))\b/i;
  const matchDirectFile = clean.match(directFileWithExtRegex);
  if (matchDirectFile) {
    return {
      isFileCommand: true,
      targetQuery: matchDirectFile[1].trim(),
      targetFolder: null,
      action: 'open',
    };
  }

  // Direct PDF or document opening: e.g. "open pdf", "open my pdf", "open the pdf", "open documents", "open files"
  const directPdfOrDocRegex = /\b(?:open|show|view|display|launch|load)\s+(?:a\s+|the\s+|my\s+)?(?:pdf|pdfs|document|documents|file|files)\b/i;
  if (directPdfOrDocRegex.test(clean)) {
    const isPdfMention = /\bpdfs?\b/i.test(clean);
    return {
      isFileCommand: true,
      targetQuery: isPdfMention ? 'pdf' : null,
      targetFolder: null,
      action: 'open',
    };
  }

  // Open / search specific file
  const fileOpenRegex = /\b(?:open|search|find|lookup|locate|view|show|get)\s+(?:a\s+|the\s+|my\s+)?(?:file|document|doc|pdf|folder|code|image|photo|video)\s+(?:named|called|for|about|with\s+name)?\s*([^\n\r.]+.*)?/i;
  const directFileSearchRegex = /\b(?:search|find|check)\s+(?:my\s+)?(?:computer|pc|disk|drive|storage|laptop|desktop|memory)\s+(?:for\s+)?(.+)/i;
  const openFileFromComputerRegex = /\b(?:search|open|find|scan)\s+(?:any\s+)?file\s+(?:from|in|on)\s+(?:my\s+)?(?:computer|pc|disk|storage|memory)(?:\s+(?:named|called|and\s+open\s+it|for)?\s*(.+))?/i;

  const m3 = clean.match(openFileFromComputerRegex);
  if (m3) {
    const isExplicitOpen = /\bopen\b/i.test(clean);
    return {
      isFileCommand: true,
      targetQuery: m3[1] ? m3[1].replace(/^(?:named|called|for)\s+/i, '').trim() : null,
      targetFolder: null,
      action: isExplicitOpen ? 'open' : 'search',
    };
  }

  const m2 = clean.match(directFileSearchRegex);
  if (m2 && m2[1].trim()) {
    return {
      isFileCommand: true,
      targetQuery: m2[1].trim(),
      targetFolder: null,
      action: 'search',
    };
  }

  const m1 = clean.match(fileOpenRegex);
  if (m1) {
    const rawTarget = m1[1] ? m1[1].trim() : '';
    if (!/^(youtube|google|reddit|spotify|twitter|netflix|wikipedia|dancing|dance|directions|left|right|around)/i.test(rawTarget)) {
      const isExplicitOpen = /^\s*open\b/i.test(clean);
      return {
        isFileCommand: true,
        targetQuery: rawTarget.length > 0 ? rawTarget : null,
        targetFolder: null,
        action: isExplicitOpen ? 'open' : 'search',
      };
    }
  }

  return {
    isFileCommand: false,
    targetQuery: null,
    targetFolder: null,
    action: 'search',
  };
}
