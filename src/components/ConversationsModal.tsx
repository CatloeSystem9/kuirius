import React, { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X, Plus, Trash2, MessageSquare, Calendar, ChevronRight, Search } from 'lucide-react';
import { Conversation } from '../types';

interface ConversationsModalProps {
  isOpen: boolean;
  onClose: () => void;
  conversations: Conversation[];
  activeConversationId: string | null;
  onSelectConversation: (id: string) => void;
  onNewConversation: () => void;
  onDeleteConversation: (id: string) => void;
}

export const ConversationsModal: React.FC<ConversationsModalProps> = ({
  isOpen,
  onClose,
  conversations,
  activeConversationId,
  onSelectConversation,
  onNewConversation,
  onDeleteConversation,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  if (!isOpen) return null;

  const filtered = conversations.filter((c) => {
    const titleMatch = c.title.toLowerCase().includes(searchQuery.toLowerCase());
    const msgMatch = c.messages.some((m) =>
      m.content.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return titleMatch || msgMatch;
  });

  const formatDate = (timestamp: number) => {
    const d = new Date(timestamp);
    return d.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
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
            <div>
              <h2 className="text-xs font-semibold tracking-[0.2em] uppercase text-blue-100/90">
                Previous Conversations
              </h2>
              <p className="text-[11px] text-blue-400/50 mt-0.5 tracking-wide">
                Recorded dialogue and past moments with Krisha
              </p>
            </div>
            <button
              onClick={onClose}
              id="close-conversations-modal"
              className="p-1.5 text-slate-500 hover:text-blue-300 hover:bg-blue-950/40 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Action Bar */}
          <div className="p-4 border-b border-blue-900/20 flex items-center gap-3 bg-[#03060d]">
            <div className="relative flex-1 flex items-center">
              <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 pointer-events-none" />
              <input
                type="text"
                placeholder="Search past conversations..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#070b16] border border-blue-900/30 rounded-xl pl-9 pr-3.5 py-2 text-xs text-slate-200 placeholder-slate-600 focus:outline-none focus:border-blue-500/40 transition-colors"
              />
            </div>
            <button
              id="btn-new-conversation"
              onClick={() => {
                onNewConversation();
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-blue-600/80 hover:bg-blue-600 text-white text-xs font-medium tracking-wider uppercase transition-all shadow-[0_0_15px_rgba(37,99,235,0.25)] cursor-pointer shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>New</span>
            </button>
          </div>

          {/* List of Conversations */}
          <div className="flex-1 overflow-y-auto p-4 space-y-2.5">
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-slate-600 text-xs font-light">
                {searchQuery ? 'No matching conversations found.' : 'No previous conversations recorded.'}
              </div>
            ) : (
              filtered.map((convo) => {
                const isActive = convo.id === activeConversationId;
                const lastMsg = convo.messages[convo.messages.length - 1]?.content || 'Empty conversation';
                const hasWebAction = convo.messages.some((m) => Boolean(m.webAction));
                const hasHabitAction = convo.messages.some((m) => Boolean(m.habitAction));

                return (
                  <div
                    key={convo.id}
                    className={`group relative flex items-center justify-between p-3.5 rounded-xl border transition-all cursor-pointer ${
                      isActive
                        ? 'bg-blue-950/30 border-blue-800/50 text-slate-100 shadow-[0_0_15px_rgba(59,130,246,0.08)]'
                        : 'bg-[#060a14] border-blue-900/20 hover:border-blue-700/40 hover:bg-[#0a1020] text-slate-300'
                    }`}
                    onClick={() => {
                      onSelectConversation(convo.id);
                      onClose();
                    }}
                  >
                    <div className="flex-1 min-w-0 pr-3">
                      <div className="flex items-center gap-2 mb-1">
                        <MessageSquare className="w-3.5 h-3.5 text-blue-400 shrink-0" />
                        <h3 className="text-xs font-medium text-slate-200 truncate">
                          {convo.title || 'Conversation'}
                        </h3>
                        {hasHabitAction && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 font-mono">
                            Habits / Goals
                          </span>
                        )}
                        {hasWebAction && (
                          <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-500/15 border border-blue-500/30 text-blue-300 font-mono">
                            Web / Media
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-slate-400 truncate line-clamp-1">
                        {lastMsg}
                      </p>
                      <div className="flex items-center gap-3 mt-2 text-[10px] text-slate-500 font-mono">
                        <span className="flex items-center gap-1">
                          <Calendar className="w-3 h-3 text-blue-500/50" />
                          {formatDate(convo.updatedAt || convo.createdAt)}
                        </span>
                        <span>{convo.messages.length} turns</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        title="Delete conversation"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeleteConversation(convo.id);
                        }}
                        className="p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-950/30 rounded-lg transition-colors opacity-80 sm:opacity-0 group-hover:opacity-100 cursor-pointer"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-blue-400 transition-colors" />
                    </div>
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
