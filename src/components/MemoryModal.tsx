import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, Trash2, Edit3, Check, BrainCircuit, Sparkles, Info } from 'lucide-react';

interface MemoryModalProps {
  isOpen: boolean;
  onClose: () => void;
  memories: string[];
  onAddMemory: (memory: string) => void;
  onUpdateMemory: (index: number, memory: string) => void;
  onDeleteMemory: (index: number) => void;
}

export const MemoryModal: React.FC<MemoryModalProps> = ({
  isOpen,
  onClose,
  memories,
  onAddMemory,
  onUpdateMemory,
  onDeleteMemory,
}) => {
  const [newMemoryInput, setNewMemoryInput] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingText, setEditingText] = useState('');

  if (!isOpen) return null;

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (newMemoryInput.trim()) {
      onAddMemory(newMemoryInput.trim());
      setNewMemoryInput('');
    }
  };

  const startEdit = (index: number, text: string) => {
    setEditingIndex(index);
    setEditingText(text);
  };

  const saveEdit = (index: number) => {
    if (editingText.trim()) {
      onUpdateMemory(index, editingText.trim());
    }
    setEditingIndex(null);
    setEditingText('');
  };

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
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
          className="relative w-full max-w-xl bg-[#050810] border border-blue-900/30 rounded-2xl shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden flex flex-col max-h-[85vh] z-10 text-slate-300"
        >
          {/* Modal Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-blue-900/20 bg-[#080d1a]">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400">
                <BrainCircuit className="w-4 h-4" />
              </div>
              <div>
                <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-blue-100/90">
                  Krisha's Memory
                </h2>
                <p className="text-[11px] text-blue-400/50 mt-0.5 tracking-wide">
                  Things Krisha remembers about you across all sessions
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              id="close-memory-modal"
              className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Memory Add Input */}
          <form onSubmit={handleAdd} className="p-4 border-b border-blue-900/20 flex gap-2 bg-[#03060d]">
            <input
              type="text"
              placeholder="Add a new memory (e.g., 'Likes late night tea', 'Works as a software engineer')..."
              value={newMemoryInput}
              onChange={(e) => setNewMemoryInput(e.target.value)}
              className="flex-1 bg-[#070b16] border border-blue-900/30 rounded-xl px-3.5 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/40 transition-colors"
            />
            <button
              type="submit"
              disabled={!newMemoryInput.trim()}
              className="px-4 py-2 bg-blue-600/80 hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-blue-600/80 text-white rounded-xl text-xs font-medium tracking-wider uppercase transition-all shadow-[0_0_15px_rgba(37,99,235,0.25)] flex items-center gap-1.5 cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add</span>
            </button>
          </form>

          {/* Live Extraction Note */}
          <div className="px-6 py-2 bg-[#060a14] border-b border-blue-950/40 flex items-center gap-2 text-[11px] text-blue-400/60 font-mono">
            <Sparkles className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            <span>Krisha automatically updates memories while you talk.</span>
          </div>

          {/* List of Memories */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {memories.length === 0 ? (
              <div className="py-12 text-center text-slate-600 text-xs font-light">
                No memories recorded yet. Tell Krisha something about yourself!
              </div>
            ) : (
              memories.map((mem, index) => {
                const isEditing = editingIndex === index;

                return (
                  <div
                    key={index}
                    className="group flex items-start justify-between gap-3 p-3.5 rounded-xl bg-[#060a14] border border-blue-900/20 hover:border-blue-700/30 hover:bg-[#080e1e] transition-all"
                  >
                    {isEditing ? (
                      <div className="flex-1 flex gap-2">
                        <input
                          type="text"
                          value={editingText}
                          onChange={(e) => setEditingText(e.target.value)}
                          className="flex-1 bg-[#091124] border border-blue-500/40 rounded-lg px-2.5 py-1 text-xs text-slate-100 focus:outline-none"
                          autoFocus
                        />
                        <button
                          onClick={() => saveEdit(index)}
                          className="p-1.5 bg-blue-600 text-white rounded-lg hover:bg-blue-500 text-xs transition-colors cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-start gap-2.5 flex-1 min-w-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1.5 shrink-0 shadow-[0_0_6px_#3b82f6]" />
                          <p className="text-xs text-slate-300 leading-relaxed break-words">
                            {mem}
                          </p>
                        </div>

                        <div className="flex items-center gap-1 shrink-0 opacity-80 sm:opacity-0 group-hover:opacity-100 transition-opacity">
                          <button
                            title="Edit memory"
                            onClick={() => startEdit(index, mem)}
                            className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            title="Delete memory"
                            onClick={() => onDeleteMemory(index)}
                            className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-950/40 rounded-lg transition-colors cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
