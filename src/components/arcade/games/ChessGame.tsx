import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Chess, Square, Move } from 'chess.js';
import {
  RotateCcw,
  Undo2,
  Swords,
  Crown,
  Sparkles,
  ArrowUpDown,
  CheckCircle,
  AlertTriangle,
} from 'lucide-react';
import { ArcadeGameShell } from '../ArcadeGameShell';
import { ARCADE_GAMES } from '../arcadeRegistry';
import { DifficultyLevel } from '../types';
import {
  playMoveSound,
  playCaptureSound,
  playCheckSound,
  playSuccessSound,
  playGameOverSound,
} from '../arcadeAudio';
import { recordGameResult, getArcadeStats } from '../../../utils/arcadeStorage';

// Piece unicode symbols & styling
const PIECE_UNICODE: Record<string, string> = {
  p: '♟',
  r: '♜',
  n: '♞',
  b: '♝',
  q: '♛',
  k: '♚',
  P: '♙',
  R: '♖',
  N: '♘',
  B: '♗',
  Q: '♕',
  K: '♔',
};

const PIECE_VALUES: Record<string, number> = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 20000,
};

// Positional Piece-Square Tables (White perspective; flipped for Black)
const PAWN_TABLE = [
  0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5,  5, 10, 25, 25, 10,  5,  5,
  0,  0,  0, 20, 20,  0,  0,  0,
  5, -5,-10,  0,  0,-10, -5,  5,
  5, 10, 10,-20,-20, 10, 10,  5,
  0,  0,  0,  0,  0,  0,  0,  0
];

const KNIGHT_TABLE = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50,
];

const BISHOP_TABLE = [
  -20,-10,-10,-10,-10,-10,-10,-20,
  -10,  0,  0,  0,  0,  0,  0,-10,
  -10,  0,  5, 10, 10,  5,  0,-10,
  -10,  5,  5, 10, 10,  5,  5,-10,
  -10,  0, 10, 10, 10, 10,  0,-10,
  -10, 10, 10, 10, 10, 10, 10,-10,
  -10,  5,  0,  0,  0,  0,  5,-10,
  -20,-10,-10,-10,-10,-10,-10,-20,
];

function evaluateBoard(game: Chess): number {
  let score = 0;
  const board = game.board();

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;

      const val = PIECE_VALUES[piece.type] || 0;
      let posVal = 0;
      const idx = piece.color === 'w' ? r * 8 + c : (7 - r) * 8 + c;

      if (piece.type === 'p') posVal = PAWN_TABLE[idx] || 0;
      else if (piece.type === 'n') posVal = KNIGHT_TABLE[idx] || 0;
      else if (piece.type === 'b') posVal = BISHOP_TABLE[idx] || 0;

      const total = val + posVal;
      score += piece.color === 'w' ? total : -total;
    }
  }
  return score;
}

// Minimax with Alpha-Beta Pruning
function minimax(
  game: Chess,
  depth: number,
  alpha: number,
  beta: number,
  isMaximizing: boolean,
  cancelRef: React.MutableRefObject<boolean>
): { score: number; bestMove?: string } {
  if (cancelRef.current || depth === 0 || game.isGameOver()) {
    return { score: evaluateBoard(game) };
  }

  const moves = game.moves({ verbose: true });
  // Move ordering: evaluate captures first for better pruning
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));

  let bestMove: string | undefined = undefined;

  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const move of moves) {
      game.move(move);
      const evaluation = minimax(game, depth - 1, alpha, beta, false, cancelRef).score;
      game.undo();
      if (evaluation > maxEval) {
        maxEval = evaluation;
        bestMove = move.san;
      }
      alpha = Math.max(alpha, evaluation);
      if (beta <= alpha) break;
    }
    return { score: maxEval, bestMove };
  } else {
    let minEval = Infinity;
    for (const move of moves) {
      game.move(move);
      const evaluation = minimax(game, depth - 1, alpha, beta, true, cancelRef).score;
      game.undo();
      if (evaluation < minEval) {
        minEval = evaluation;
        bestMove = move.san;
      }
      beta = Math.min(beta, evaluation);
      if (beta <= alpha) break;
    }
    return { score: minEval, bestMove };
  }
}

interface ChessGameProps {
  onBack: () => void;
  initialDifficulty?: DifficultyLevel;
}

export const ChessGame: React.FC<ChessGameProps> = ({
  onBack,
  initialDifficulty = 'medium',
}) => {
  const metadata = ARCADE_GAMES.find((g) => g.id === 'chess')!;
  const [chessInstance] = useState(() => new Chess());
  const [, setRenderTrigger] = useState(0);

  const [difficulty, setDifficulty] = useState<DifficultyLevel>(initialDifficulty);
  const [playerColor, setPlayerColor] = useState<'w' | 'b'>('w');
  const [selectedSquare, setSelectedSquare] = useState<Square | null>(null);
  const [legalMoves, setLegalMoves] = useState<Move[]>([]);
  const [isAiThinking, setIsAiThinking] = useState(false);
  const [pendingPromotion, setPendingPromotion] = useState<{
    from: Square;
    to: Square;
  } | null>(null);

  const [historyMoves, setHistoryMoves] = useState<string[]>([]);
  const [capturedWhite, setCapturedWhite] = useState<string[]>([]);
  const [capturedBlack, setCapturedBlack] = useState<string[]>([]);

  const cancelAiRef = useRef(false);
  const aiTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const rerender = useCallback(() => setRenderTrigger((n) => n + 1), []);

  // Update captured pieces & move history
  const updateGameStats = useCallback(() => {
    setHistoryMoves(chessInstance.history());

    const capturedByBlack: string[] = []; // white pieces lost
    const capturedByWhite: string[] = []; // black pieces lost

    const currentPieces = { p: 0, n: 0, b: 0, r: 0, q: 0, P: 0, N: 0, B: 0, R: 0, Q: 0 };
    const board = chessInstance.board();
    for (const row of board) {
      for (const piece of row) {
        if (piece) {
          const key = piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
          currentPieces[key as keyof typeof currentPieces] =
            (currentPieces[key as keyof typeof currentPieces] || 0) + 1;
        }
      }
    }

    const startingWhite = { P: 8, N: 2, B: 2, R: 2, Q: 1 };
    const startingBlack = { p: 8, n: 2, b: 2, r: 2, q: 1 };

    for (const [p, count] of Object.entries(startingWhite)) {
      const diff = count - (currentPieces[p as keyof typeof currentPieces] || 0);
      for (let i = 0; i < diff; i++) capturedByBlack.push(p);
    }
    for (const [p, count] of Object.entries(startingBlack)) {
      const diff = count - (currentPieces[p as keyof typeof currentPieces] || 0);
      for (let i = 0; i < diff; i++) capturedByWhite.push(p);
    }

    setCapturedWhite(capturedByBlack);
    setCapturedBlack(capturedByWhite);
  }, [chessInstance]);

  // Clean up AI timer and search on unmount
  useEffect(() => {
    return () => {
      cancelAiRef.current = true;
      if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
    };
  }, []);

  // Local Computer Opponent Move Logic
  const triggerAiMove = useCallback(() => {
    if (chessInstance.isGameOver()) return;
    if (chessInstance.turn() === playerColor) return;

    setIsAiThinking(true);
    cancelAiRef.current = false;

    // Use setTimeout so the UI stays responsive and displays player move immediately
    aiTimeoutRef.current = setTimeout(() => {
      if (cancelAiRef.current) {
        setIsAiThinking(false);
        return;
      }

      const moves = chessInstance.moves({ verbose: true });
      if (moves.length === 0) {
        setIsAiThinking(false);
        return;
      }

      let chosenMove: Move | null = null;

      if (difficulty === 'easy') {
        // Easy: 70% random, 30% shallow evaluation
        if (Math.random() < 0.6) {
          chosenMove = moves[Math.floor(Math.random() * moves.length)];
        } else {
          const { bestMove } = minimax(
            chessInstance,
            1,
            -Infinity,
            Infinity,
            playerColor === 'b',
            cancelAiRef
          );
          chosenMove = moves.find((m) => m.san === bestMove) || moves[0];
        }
      } else if (difficulty === 'medium') {
        // Medium: depth 2 evaluation with piece-square heuristics
        const { bestMove } = minimax(
          chessInstance,
          2,
          -Infinity,
          Infinity,
          playerColor === 'b',
          cancelAiRef
        );
        chosenMove = moves.find((m) => m.san === bestMove) || moves[0];
      } else {
        // Hard: depth 3 alpha-beta search
        const { bestMove } = minimax(
          chessInstance,
          3,
          -Infinity,
          Infinity,
          playerColor === 'b',
          cancelAiRef
        );
        chosenMove = moves.find((m) => m.san === bestMove) || moves[0];
      }

      if (chosenMove && !cancelAiRef.current) {
        try {
          const res = chessInstance.move(chosenMove);
          if (res) {
            if (res.captured) playCaptureSound();
            else playMoveSound();

            if (chessInstance.inCheck()) playCheckSound();

            updateGameStats();
            rerender();

            if (chessInstance.isGameOver()) {
              if (chessInstance.isCheckmate()) {
                playGameOverSound();
                recordGameResult('chess', { loss: true });
              } else {
                recordGameResult('chess', { draw: true });
              }
            }
          }
        } catch (e) {
          console.error('AI Move Error:', e);
        }
      }
      setIsAiThinking(false);
    }, 350);
  }, [chessInstance, playerColor, difficulty, updateGameStats, rerender]);

  // Handle Square Clicks
  const handleSquareClick = (square: Square) => {
    if (isAiThinking || chessInstance.isGameOver()) return;
    if (chessInstance.turn() !== playerColor) return;

    const piece = chessInstance.get(square);

    // If already selected and clicked another square
    if (selectedSquare) {
      if (selectedSquare === square) {
        setSelectedSquare(null);
        setLegalMoves([]);
        return;
      }

      // Check if target square is in legal moves
      const candidateMove = legalMoves.find((m) => m.to === square);

      if (candidateMove) {
        // Check for promotion
        if (
          candidateMove.piece === 'p' &&
          ((candidateMove.color === 'w' && square[1] === '8') ||
            (candidateMove.color === 'b' && square[1] === '1'))
        ) {
          setPendingPromotion({ from: selectedSquare, to: square });
          return;
        }

        // Execute Move
        try {
          const res = chessInstance.move({
            from: selectedSquare,
            to: square,
          });

          if (res) {
            if (res.captured) playCaptureSound();
            else playMoveSound();

            if (chessInstance.inCheck()) playCheckSound();

            setSelectedSquare(null);
            setLegalMoves([]);
            updateGameStats();
            rerender();

            if (chessInstance.isGameOver()) {
              if (chessInstance.isCheckmate()) {
                playSuccessSound();
                recordGameResult('chess', { won: true });
              } else {
                recordGameResult('chess', { draw: true });
              }
            } else {
              triggerAiMove();
            }
            return;
          }
        } catch {
          // invalid move fallback
        }
      }
    }

    // New selection: only allow selecting pieces of the player's color
    if (piece && piece.color === playerColor) {
      setSelectedSquare(square);
      const moves = chessInstance.moves({ square, verbose: true });
      setLegalMoves(moves);
    } else {
      setSelectedSquare(null);
      setLegalMoves([]);
    }
  };

  // Handle Promotion choice
  const handlePromote = (promoPiece: 'q' | 'r' | 'b' | 'n') => {
    if (!pendingPromotion) return;
    try {
      const res = chessInstance.move({
        from: pendingPromotion.from,
        to: pendingPromotion.to,
        promotion: promoPiece,
      });
      if (res) {
        if (res.captured) playCaptureSound();
        else playMoveSound();

        setPendingPromotion(null);
        setSelectedSquare(null);
        setLegalMoves([]);
        updateGameStats();
        rerender();

        if (chessInstance.isGameOver()) {
          if (chessInstance.isCheckmate()) {
            playSuccessSound();
            recordGameResult('chess', { won: true });
          } else {
            recordGameResult('chess', { draw: true });
          }
        } else {
          triggerAiMove();
        }
      }
    } catch {
      setPendingPromotion(null);
    }
  };

  // Undo Move
  const handleUndo = () => {
    if (isAiThinking || historyMoves.length === 0) return;
    // Undo opponent's move and player's move
    if (chessInstance.turn() === playerColor) {
      chessInstance.undo();
      chessInstance.undo();
    } else {
      chessInstance.undo();
    }
    setSelectedSquare(null);
    setLegalMoves([]);
    updateGameStats();
    rerender();
  };

  // Restart
  const handleRestart = () => {
    cancelAiRef.current = true;
    if (aiTimeoutRef.current) clearTimeout(aiTimeoutRef.current);
    setIsAiThinking(false);
    chessInstance.reset();
    setSelectedSquare(null);
    setLegalMoves([]);
    setPendingPromotion(null);
    updateGameStats();
    rerender();

    if (playerColor === 'b') {
      setTimeout(() => triggerAiMove(), 400);
    }
  };

  // Flip Color
  const handleFlipColor = () => {
    const newColor = playerColor === 'w' ? 'b' : 'w';
    setPlayerColor(newColor);
    handleRestart();
  };

  const isGameOver = chessInstance.isGameOver();
  const inCheck = chessInstance.inCheck();
  const turn = chessInstance.turn();
  const isPlayerTurn = turn === playerColor;

  // Board layout indices based on playerColor perspective
  const ranks = playerColor === 'w' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
  const files = playerColor === 'w' ? ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] : ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a'];

  // Status message
  let statusText = '';
  if (isGameOver) {
    if (chessInstance.isCheckmate()) {
      statusText = isPlayerTurn ? 'Checkmate — Krisha won!' : 'Checkmate — You won!';
    } else if (chessInstance.isStalemate()) {
      statusText = 'Draw by Stalemate';
    } else if (chessInstance.isThreefoldRepetition()) {
      statusText = 'Draw by Threefold Repetition';
    } else if (chessInstance.isInsufficientMaterial()) {
      statusText = 'Draw by Insufficient Material';
    } else {
      statusText = 'Game Drawn';
    }
  } else if (inCheck) {
    statusText = isPlayerTurn ? '⚠️ Your King is in Check!' : 'Krisha is in Check!';
  } else {
    statusText = isAiThinking
      ? "Krisha is planning her move..."
      : isPlayerTurn
      ? "Your turn (White)"
      : "Krisha's turn";
  }

  const stats = getArcadeStats('chess');

  return (
    <ArcadeGameShell
      metadata={metadata}
      onBack={onBack}
      onRestart={handleRestart}
      stats={stats}
      headerExtras={
        <div className="flex items-center gap-1.5 sm:gap-2">
          {/* Difficulty selector */}
          <div className="flex items-center p-0.5 rounded-lg bg-blue-950/60 border border-blue-900/40 text-xs">
            {(['easy', 'medium', 'hard'] as DifficultyLevel[]).map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setDifficulty(lvl)}
                className={`px-2 py-1 rounded-md capitalize font-medium transition-all cursor-pointer ${
                  difficulty === lvl
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          {/* Undo */}
          <button
            type="button"
            onClick={handleUndo}
            disabled={historyMoves.length === 0 || isAiThinking}
            className="p-1.5 sm:p-2 rounded-xl text-slate-300 bg-blue-950/40 border border-blue-800/40 hover:bg-blue-900/40 disabled:opacity-30 disabled:cursor-not-allowed transition-all cursor-pointer"
            title="Undo move"
          >
            <Undo2 className="w-4 h-4" />
          </button>

          {/* Flip Board */}
          <button
            type="button"
            onClick={handleFlipColor}
            className="p-1.5 sm:p-2 rounded-xl text-slate-300 bg-blue-950/40 border border-blue-800/40 hover:bg-blue-900/40 transition-all cursor-pointer"
            title="Flip Board / Swap Sides"
          >
            <ArrowUpDown className="w-4 h-4" />
          </button>
        </div>
      }
    >
      <div className="flex flex-col lg:flex-row items-center justify-center gap-4 sm:gap-6 max-w-5xl w-full mx-auto">
        {/* Left / Center: The Chessboard */}
        <div className="flex flex-col items-center">
          {/* Opponent Status Bar */}
          <div className="w-full flex items-center justify-between px-3 py-1.5 mb-1.5 bg-blue-950/40 border border-blue-900/30 rounded-xl text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-indigo-400 shadow-[0_0_6px_#818cf8]" />
              <span className="font-semibold text-slate-200">Krisha ({difficulty})</span>
              {isAiThinking && (
                <span className="text-indigo-400 text-[11px] animate-pulse flex items-center gap-1">
                  <Sparkles className="w-3 h-3" /> Thinking...
                </span>
              )}
            </div>
            <div className="flex items-center gap-1 font-mono text-sm tracking-tighter text-slate-400">
              {capturedWhite.map((p, idx) => (
                <span key={idx} className="text-slate-300">{PIECE_UNICODE[p]}</span>
              ))}
            </div>
          </div>

          {/* 8x8 Board Container */}
          <div className="relative p-2 sm:p-3 rounded-2xl bg-[#0d1424] border-2 border-blue-900/40 shadow-2xl shadow-blue-950/50">
            <div className="grid grid-cols-8 grid-rows-8 w-[min(88vw,420px)] h-[min(88vw,420px)] sm:w-[440px] sm:h-[440px] border border-blue-900/60 rounded-lg overflow-hidden select-none">
              {ranks.map((r, rIdx) =>
                files.map((f, fIdx) => {
                  const square = `${f}${r}` as Square;
                  const isLight = (rIdx + fIdx) % 2 === 0;
                  const piece = chessInstance.get(square);
                  const isSelected = selectedSquare === square;
                  const isLegalTarget = legalMoves.some((m) => m.to === square);
                  const isLastMove = historyMoves.length > 0 && chessInstance.history({ verbose: true }).slice(-1)[0]?.to === square;

                  return (
                    <button
                      key={square}
                      type="button"
                      onClick={() => handleSquareClick(square)}
                      className={`relative flex items-center justify-center transition-colors font-serif cursor-pointer ${
                        isLight ? 'bg-[#1b253b]' : 'bg-[#0f172a]'
                      } ${
                        isSelected
                          ? 'ring-2 ring-inset ring-amber-400 bg-amber-950/40'
                          : isLastMove
                          ? 'bg-blue-900/40'
                          : ''
                      }`}
                    >
                      {/* Rank & File notation coordinates */}
                      {fIdx === 0 && (
                        <span className="absolute top-0.5 left-1 text-[9px] text-slate-500 font-sans font-medium pointer-events-none">
                          {r}
                        </span>
                      )}
                      {rIdx === 7 && (
                        <span className="absolute bottom-0.5 right-1 text-[9px] text-slate-500 font-sans font-medium pointer-events-none">
                          {f}
                        </span>
                      )}

                      {/* Piece Icon */}
                      {piece && (
                        <span
                          className={`text-3xl sm:text-4xl drop-shadow-md select-none transform transition-transform hover:scale-105 ${
                            piece.color === 'w'
                              ? 'text-slate-100 filter drop-shadow-[0_2px_4px_rgba(255,255,255,0.25)]'
                              : 'text-indigo-400 filter drop-shadow-[0_2px_4px_rgba(99,102,241,0.4)]'
                          }`}
                        >
                          {PIECE_UNICODE[piece.color === 'w' ? piece.type.toUpperCase() : piece.type]}
                        </span>
                      )}

                      {/* Legal Move Indicator */}
                      {isLegalTarget && (
                        <span
                          className={`absolute rounded-full pointer-events-none ${
                            piece
                              ? 'w-full h-full border-2 border-emerald-400/80 bg-emerald-500/15'
                              : 'w-3.5 h-3.5 bg-emerald-400/80 shadow-[0_0_8px_#34d399]'
                          }`}
                        />
                      )}
                    </button>
                  );
                })
              )}
            </div>

            {/* Pawn Promotion Modal Overlay */}
            {pendingPromotion && (
              <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/80 rounded-2xl p-4">
                <div className="bg-[#0b1120] border border-blue-500/50 p-4 rounded-xl shadow-2xl text-center">
                  <h4 className="text-xs uppercase tracking-wider text-slate-300 font-bold mb-3">
                    Choose Promotion
                  </h4>
                  <div className="flex gap-2">
                    {(['q', 'r', 'b', 'n'] as const).map((p) => (
                      <button
                        key={p}
                        type="button"
                        onClick={() => handlePromote(p)}
                        className="w-12 h-12 rounded-lg bg-blue-900/40 hover:bg-blue-600/50 border border-blue-700 text-3xl flex items-center justify-center text-white transition-all cursor-pointer"
                      >
                        {PIECE_UNICODE[playerColor === 'w' ? p.toUpperCase() : p]}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Player Status Bar */}
          <div className="w-full flex items-center justify-between px-3 py-1.5 mt-1.5 bg-blue-950/40 border border-blue-900/30 rounded-xl text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_6px_#34d399]" />
              <span className="font-semibold text-slate-200">You ({playerColor === 'w' ? 'White' : 'Black'})</span>
            </div>
            <div className="flex items-center gap-1 font-mono text-sm tracking-tighter text-slate-400">
              {capturedBlack.map((p, idx) => (
                <span key={idx} className="text-indigo-400">{PIECE_UNICODE[p]}</span>
              ))}
            </div>
          </div>
        </div>

        {/* Right: Match Stats & Move History Panel */}
        <div className="w-full lg:w-72 flex flex-col gap-3 bg-[#0a0f1d] border border-blue-900/30 rounded-2xl p-3 sm:p-4 text-xs">
          {/* Turn & Outcome Banner */}
          <div
            className={`p-3 rounded-xl border flex items-center gap-2.5 ${
              isGameOver
                ? 'bg-indigo-950/40 border-indigo-500/50 text-indigo-200'
                : inCheck
                ? 'bg-rose-950/40 border-rose-500/50 text-rose-200 animate-pulse'
                : 'bg-blue-950/30 border-blue-900/40 text-blue-200'
            }`}
          >
            {isGameOver ? (
              <Crown className="w-5 h-5 text-amber-400 shrink-0" />
            ) : inCheck ? (
              <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0" />
            ) : (
              <Swords className="w-5 h-5 text-blue-400 shrink-0" />
            )}
            <span className="font-medium text-xs sm:text-sm">{statusText}</span>
          </div>

          {/* Move History Log */}
          <div className="flex-1 min-h-[160px] max-h-[220px] flex flex-col bg-[#060a14] rounded-xl border border-blue-950 p-2.5 overflow-hidden">
            <span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 mb-1.5">
              Move Notation (SAN)
            </span>
            <div className="flex-1 overflow-y-auto space-y-1 font-mono text-[11px] pr-1">
              {historyMoves.length === 0 ? (
                <span className="text-slate-600 italic">No moves recorded yet</span>
              ) : (
                Array.from({ length: Math.ceil(historyMoves.length / 2) }).map((_, idx) => (
                  <div key={idx} className="flex items-center text-slate-300 py-0.5 border-b border-blue-950/50">
                    <span className="w-6 text-slate-500">{idx + 1}.</span>
                    <span className="w-16 font-semibold text-slate-200">{historyMoves[idx * 2]}</span>
                    <span className="w-16 text-indigo-300">{historyMoves[idx * 2 + 1] || ''}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Quick Stats Summary */}
          <div className="grid grid-cols-3 gap-2 text-center pt-1 border-t border-blue-900/20">
            <div className="p-1.5 rounded-lg bg-blue-950/20 border border-blue-900/30">
              <span className="text-[10px] text-slate-400 block">Wins</span>
              <span className="text-sm font-bold text-emerald-400 font-mono">{stats.wins || 0}</span>
            </div>
            <div className="p-1.5 rounded-lg bg-blue-950/20 border border-blue-900/30">
              <span className="text-[10px] text-slate-400 block">Losses</span>
              <span className="text-sm font-bold text-rose-400 font-mono">{stats.losses || 0}</span>
            </div>
            <div className="p-1.5 rounded-lg bg-blue-950/20 border border-blue-900/30">
              <span className="text-[10px] text-slate-400 block">Draws</span>
              <span className="text-sm font-bold text-amber-400 font-mono">{stats.draws || 0}</span>
            </div>
          </div>
        </div>
      </div>
    </ArcadeGameShell>
  );
};
export default ChessGame;
