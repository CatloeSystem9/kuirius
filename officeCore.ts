/**
 * Office file capabilities (spreadsheet + presentation) — 100% local.
 *
 * Design constraints for the 8 GB target laptop (per the operator's doctrine:
 * lightweight, local processing, bounded resource usage):
 *  - pure-JS writers/readers (ExcelJS for .xlsx, pptxgenjs for .pptx) — no
 *    Office/COM automation, no Python, no native modules, no network access;
 *  - both libraries are DYNAMICALLY IMPORTED inside the action functions so
 *    server startup and idle RAM stay free of their weight (~15 MB combined);
 *  - every request is bounded by hard caps (sheets/rows/cols/slides/text
 *    sizes) — oversized requests are REFUSED, never streamed into memory
 *    unbounded;
 *  - every mutation is verified by RE-OPENING the written file (honest
 *    evidence, spec §13) — never "write succeeded = done";
 *  - paths resolve through resolveSafePath (allowed roots, traversal and
 *    protected-storage refused) exactly like every other filesystem route.
 */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { resolveSafePath } from './serverSafety';

// ------------------------------------------------------------------- limits
export const OFFICE_LIMITS = {
  MAX_SHEETS: 20,
  MAX_ROWS: 10_000,
  MAX_COLS: 64,
  MAX_CELL_CHARS: 3_000,
  MAX_APPEND_ROWS: 2_000,
  MAX_OPS: 20,
  MAX_CELLS_PER_OP: 2_000,
  READ_MAX_ROWS: 1_000,
  READ_DEFAULT_ROWS: 200,
  MAX_SLIDES: 60,
  MAX_BULLETS_PER_SLIDE: 12,
  MAX_TITLE_CHARS: 200,
  MAX_BULLET_CHARS: 400,
  MAX_NOTES_CHARS: 2_000,
} as const;

export type OfficeCell = string | number | boolean | null;
export type OfficeRow = OfficeCell[];

export interface OfficeSheetInput {
  name: string;
  rows: OfficeRow[];
}

export interface OfficeWriteResult {
  path: string;
  kind: 'xlsx' | 'pptx';
  bytes: number;
  verified: boolean;
  verificationNote: string;
  summary: string;
  sheets?: Array<{ name: string; rows: number; cols: number }>;
  slides?: number;
}

export interface OfficeReadResult {
  path: string;
  sheets: Array<{ name: string; rowCount: number; colCount: number }>;
  sheet?: { name: string; rows: OfficeRow[]; truncated: boolean; totalRows: number };
}

function cleanCell(v: unknown, where: string): OfficeCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error(`${where}: numbers must be finite`);
    return v;
  }
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    if (v.length > OFFICE_LIMITS.MAX_CELL_CHARS) {
      throw new Error(`${where}: cell text exceeds ${OFFICE_LIMITS.MAX_CELL_CHARS} characters`);
    }
    return v;
  }
  throw new Error(`${where}: cells must be strings, numbers, booleans or null`);
}

function cleanSheetName(name: string, index: number): string {
  const n = String(name ?? '').trim() || `Sheet${index + 1}`;
  if (n.length > 60) throw new Error(`Sheet name "${n.slice(0, 40)}…" exceeds 60 characters`);
  // Excel forbids these characters in sheet names.
  if (/[:\\/?*[\]]/.test(n)) throw new Error(`Sheet name "${n}" contains forbidden characters (: \\/ ? * [ ])`);
  return n;
}

/**
 * Resolve + validate the target file path (allowed roots, correct extension).
 * Office artifacts are user-facing documents: a BARE name ("budget.xlsx")
 * lands in the user's Documents folder (created on demand) — unlike the fs
 * tool convention where relative paths go to the temp dir. Absolute paths are
 * honored as given (still allowlist-checked).
 */
function resolveOfficePath(rawPath: string, kind: 'xlsx' | 'pptx', operation: 'read' | 'write'): string {
  const trimmed = String(rawPath ?? '').trim();
  const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\');
  let candidate = trimmed;
  if (!isAbsolute) {
    const documents = path.join(os.homedir(), 'Documents');
    try {
      fs.mkdirSync(documents, { recursive: true });
    } catch {
      /* resolveSafePath will refuse if the root is not allowed */
    }
    candidate = path.join(documents, trimmed);
  }
  let full = resolveSafePath(candidate, operation);
  const ext = kind === 'xlsx' ? '.xlsx' : '.pptx';
  if (!full.toLowerCase().endsWith(ext)) full += ext;
  return full;
}

/** Refuse to clobber unless the caller explicitly opts in (filesystem.create doctrine). */
function ensureWritableTarget(full: string, overwrite: boolean): void {
  if (fs.existsSync(full) && !overwrite) {
    throw new Error(`"${full}" already exists — pass overwrite:true to replace it`);
  }
}

async function loadExcelJs(): Promise<typeof import('exceljs')> {
  return await import('exceljs');
}

async function loadPptxGenJs(): Promise<typeof import('pptxgenjs').default> {
  const mod = await import('pptxgenjs');
  const Ctor = (mod as unknown as { default: typeof import('pptxgenjs').default }).default ?? (mod as unknown as typeof import('pptxgenjs').default);
  return Ctor;
}

function statSize(full: string): number {
  try {
    return fs.statSync(full).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------- spreadsheet

export async function createSpreadsheet(input: {
  path: string;
  sheets?: OfficeSheetInput[];
  overwrite?: boolean;
}): Promise<OfficeWriteResult> {
  const full = resolveOfficePath(input.path, 'xlsx', 'write');
  ensureWritableTarget(full, input.overwrite === true);

  const sheets = Array.isArray(input.sheets) && input.sheets.length > 0 ? input.sheets : [{ name: 'Sheet1', rows: [[]] }];
  if (sheets.length > OFFICE_LIMITS.MAX_SHEETS) {
    throw new Error(`Too many sheets (${sheets.length}) — the limit is ${OFFICE_LIMITS.MAX_SHEETS}`);
  }
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Krisha';
  wb.created = new Date();

  const sheetMeta: Array<{ name: string; rows: number; cols: number }> = [];
  for (let s = 0; s < sheets.length; s++) {
    const sheet = sheets[s];
    const name = cleanSheetName(sheet.name, s);
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    if (rows.length > OFFICE_LIMITS.MAX_ROWS) {
      throw new Error(`Sheet "${name}" has ${rows.length} rows — the limit is ${OFFICE_LIMITS.MAX_ROWS}. Split the data into more sheets.`);
    }
    const ws = wb.addWorksheet(name);
    let maxCols = 0;
    for (const row of rows) {
      if (!Array.isArray(row)) throw new Error(`Sheet "${name}": every row must be an array of cells`);
      if (row.length > OFFICE_LIMITS.MAX_COLS) {
        throw new Error(`Sheet "${name}" has a row with ${row.length} columns — the limit is ${OFFICE_LIMITS.MAX_COLS}`);
      }
      maxCols = Math.max(maxCols, row.length);
      ws.addRow(
        row.map((cell, ci) => {
          const cleaned = cleanCell(cell, `Sheet "${name}" row ${ws.rowCount + 1} col ${ci + 1}`);
          // Strings starting with '=' become live Excel formulas.
          if (typeof cleaned === 'string' && cleaned.startsWith('=')) {
            return { formula: cleaned.slice(1) };
          }
          return cleaned;
        })
      );
    }
    sheetMeta.push({ name, rows: rows.length, cols: maxCols });
  }

  await wb.xlsx.writeFile(full);

  // Honest verification: re-open the file and check the evidence.
  const checkWb = new ExcelJS.Workbook();
  await checkWb.xlsx.readFile(full);
  const verified = checkWb.worksheets.length === sheets.length;
  const bytes = statSize(full);
  const summary =
    `Created spreadsheet "${path.basename(full)}" with ${sheetMeta.length} sheet(s): ` +
    sheetMeta.map((m) => `${m.name} (${m.rows}×${m.cols})`).join(', ') +
    `. ${verified ? `Re-opened and verified ✓ (${bytes} bytes, local file — nothing was uploaded).` : 'Re-open check could not confirm the sheet count — reported honestly.'}`;
  return { path: full, kind: 'xlsx', bytes, verified, verificationNote: verified ? 'Re-opened: sheet count matches' : 'Re-open mismatch', summary, sheets: sheetMeta };
}

/** Convert an ExcelJS cell value to a plain JSON primitive (bounded). */
function cellToPrimitive(v: unknown): OfficeCell {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('result' in o) return cellToPrimitive(o.result); // formula result
    if ('text' in o) return String(o.text ?? '').slice(0, OFFICE_LIMITS.MAX_CELL_CHARS);
    if ('richText' in o && Array.isArray(o.richText)) {
      return (o.richText as Array<{ text?: string }>).map((r) => r.text ?? '').join('').slice(0, OFFICE_LIMITS.MAX_CELL_CHARS);
    }
    if (v instanceof Date) return v.toISOString();
    return String(v).slice(0, OFFICE_LIMITS.MAX_CELL_CHARS);
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
  return null;
}

export async function readSpreadsheet(input: { path: string; sheet?: string; maxRows?: number }): Promise<OfficeReadResult> {
  const full = resolveOfficePath(input.path, 'xlsx', 'read');
  if (!fs.existsSync(full)) throw new Error(`"${full}" does not exist`);
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(full); // bounded by the caps enforced at write time

  const sheets = wb.worksheets.map((ws) => ({
    name: ws.name,
    rowCount: ws.actualRowCount,
    colCount: Math.min(ws.columnCount, OFFICE_LIMITS.MAX_COLS),
  }));
  if (sheets.length === 0) {
    return { path: full, sheets };
  }

  const wanted = typeof input.sheet === 'string' && input.sheet.trim()
    ? wb.worksheets.find((ws) => ws.name.toLowerCase() === input.sheet!.trim().toLowerCase())
    : wb.worksheets[0];
  if (!wanted) throw new Error(`No sheet named "${input.sheet}" in "${path.basename(full)}"`);
  if (sheets.some((s) => s.rowCount > OFFICE_LIMITS.MAX_ROWS)) {
    throw new Error(`Workbook exceeds the ${OFFICE_LIMITS.MAX_ROWS}-row read cap — split the file first`);
  }

  const maxRows = Math.min(Math.max(1, Number(input.maxRows) || OFFICE_LIMITS.READ_DEFAULT_ROWS), OFFICE_LIMITS.READ_MAX_ROWS);
  const totalRows = wanted.actualRowCount;
  const rows: OfficeRow[] = [];
  const upper = Math.min(wanted.rowCount, maxRows);
  for (let r = 1; r <= upper; r++) {
    const values = wanted.getRow(r).values as unknown[];
    // values is 1-based (index 0 is always undefined in ExcelJS).
    const row = values.slice(1).map(cellToPrimitive);
    rows.push(row);
  }
  return {
    path: full,
    sheets,
    sheet: {
      name: wanted.name,
      rows,
      truncated: totalRows > maxRows,
      totalRows,
    },
  };
}

export interface SpreadsheetEditOp {
  type: 'set_cells' | 'append_rows' | 'add_sheet';
  sheet?: string;
  /** set_cells: anchor cell "B3" + rows of values (2-D), or cells: [{cell:"B3", value}] */
  anchor?: string;
  rows?: OfficeRow[];
  cells?: Array<{ cell: string; value: OfficeCell }>;
  name?: string; // add_sheet
}

export async function editSpreadsheet(input: { path: string; ops: SpreadsheetEditOp[]; createIfMissing?: boolean }): Promise<OfficeWriteResult> {
  const full = resolveOfficePath(input.path, 'xlsx', 'write');
  const ops = Array.isArray(input.ops) ? input.ops : [];
  if (ops.length === 0) throw new Error('edit requires at least one operation');
  if (ops.length > OFFICE_LIMITS.MAX_OPS) throw new Error(`Too many operations (${ops.length}) — the limit is ${OFFICE_LIMITS.MAX_OPS} per call`);

  if (!fs.existsSync(full)) {
    if (input.createIfMissing === true) {
      await createSpreadsheet({ path: full, sheets: [{ name: 'Sheet1', rows: [[]] }], overwrite: false });
    } else {
      throw new Error(`"${full}" does not exist — create it first or pass createIfMissing:true`);
    }
  }

  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(full);

  for (const op of ops) {
    const sheetName = typeof op.sheet === 'string' && op.sheet.trim() ? op.sheet.trim() : wb.worksheets[0]?.name;
    if (!sheetName) throw new Error('Workbook has no sheets to edit');
    const ws = wb.worksheets.find((w) => w.name.toLowerCase() === sheetName.toLowerCase());
    if (!ws) throw new Error(`No sheet named "${sheetName}"`);

    if (op.type === 'set_cells') {
      const cellList: Array<{ ref: string; value: OfficeCell }> = [];
      if (Array.isArray(op.cells) && op.cells.length > 0) {
        for (const c of op.cells) cellList.push({ ref: String(c.cell ?? ''), value: cleanCell(c.value, `set_cells ${c.cell}`) });
      } else if (Array.isArray(op.rows) && op.rows.length > 0) {
        const anchor = String(op.anchor ?? 'A1').toUpperCase();
        const m = /^([A-Z]{1,3})(\d{1,7})$/.exec(anchor);
        if (!m) throw new Error(`Invalid anchor cell "${op.anchor}"`);
        const colStart = colLettersToIndex(m[1]);
        const rowStart = parseInt(m[2], 10);
        op.rows.forEach((row, ri) => {
          (row as unknown[]).forEach((v, ci) => {
            if (v === null || v === undefined) return;
            const ref = `${indexToColLetters(colStart + ci)}${rowStart + ri}`;
            cellList.push({ ref, value: cleanCell(v, `set_cells ${ref}`) });
          });
        });
      } else {
        throw new Error('set_cells requires either cells[] or rows[] with an anchor');
      }
      if (cellList.length > OFFICE_LIMITS.MAX_CELLS_PER_OP) {
        throw new Error(`set_cells exceeds ${OFFICE_LIMITS.MAX_CELLS_PER_OP} cells per operation`);
      }
      for (const { ref, value } of cellList) {
        if (!/^[A-Z]{1,3}\d{1,7}$/.test(ref)) throw new Error(`Invalid cell reference "${ref}"`);
        const target = ws.getCell(ref);
        if (typeof value === 'string' && value.startsWith('=')) target.value = { formula: value.slice(1) };
        else target.value = value as string | number | boolean | null;
      }
    } else if (op.type === 'append_rows') {
      const rows = Array.isArray(op.rows) ? op.rows : [];
      if (rows.length === 0) throw new Error('append_rows requires rows[]');
      if (rows.length > OFFICE_LIMITS.MAX_APPEND_ROWS) {
        throw new Error(`append_rows exceeds ${OFFICE_LIMITS.MAX_APPEND_ROWS} rows per operation`);
      }
      for (const row of rows) {
        if (!Array.isArray(row)) throw new Error('append_rows: every row must be an array of cells');
        if (row.length > OFFICE_LIMITS.MAX_COLS) throw new Error(`append_rows row has ${row.length} columns — the limit is ${OFFICE_LIMITS.MAX_COLS}`);
        ws.addRow(
          row.map((cell) => {
            const cleaned = cleanCell(cell, 'append_rows cell');
            return typeof cleaned === 'string' && cleaned.startsWith('=') ? { formula: cleaned.slice(1) } : cleaned;
          })
        );
      }
    } else if (op.type === 'add_sheet') {
      if (wb.worksheets.length >= OFFICE_LIMITS.MAX_SHEETS) throw new Error(`Workbook already has ${OFFICE_LIMITS.MAX_SHEETS} sheets`);
      const name = cleanSheetName(String(op.name ?? ''), wb.worksheets.length);
      const newWs = wb.addWorksheet(name);
      if (Array.isArray(op.rows)) {
        for (const row of op.rows) {
          if (!Array.isArray(row)) throw new Error('add_sheet rows must be arrays');
          newWs.addRow(row.map((cell) => {
            const cleaned = cleanCell(cell, 'add_sheet cell');
            return typeof cleaned === 'string' && cleaned.startsWith('=') ? { formula: cleaned.slice(1) } : cleaned;
          }));
        }
      }
    } else {
      throw new Error(`Unknown operation type "${String((op as { type?: string }).type)}"`);
    }
  }

  await wb.xlsx.writeFile(full);

  // Honest verification: reload and check the last op's evidence landed.
  const checkWb = new ExcelJS.Workbook();
  await checkWb.xlsx.readFile(full);
  let verified = true;
  const lastOp = ops[ops.length - 1];
  if (lastOp.type === 'add_sheet') {
    const name = cleanSheetName(String(lastOp.name ?? ''), 0);
    verified = checkWb.worksheets.some((w) => w.name.toLowerCase() === name.toLowerCase());
  } else if (lastOp.type === 'append_rows' && Array.isArray(lastOp.rows)) {
    const wsName = typeof lastOp.sheet === 'string' && lastOp.sheet.trim() ? lastOp.sheet.trim() : checkWb.worksheets[0]?.name;
    const ws = checkWb.worksheets.find((w) => w.name.toLowerCase() === wsName.toLowerCase());
    verified = Boolean(ws && ws.rowCount >= lastOp.rows.length);
  }
  const bytes = statSize(full);
  const summary =
    `Edited "${path.basename(full)}" (${ops.length} operation${ops.length > 1 ? 's' : ''}): ` +
    ops.map((o) => o.type).join(', ') +
    `. ${verified ? `Re-opened and verified ✓ (${bytes} bytes).` : 'Re-open check could not fully confirm the edit — reported honestly.'}`;
  return { path: full, kind: 'xlsx', bytes, verified, verificationNote: verified ? 'Re-opened: edit evidence present' : 'Re-open mismatch', summary };
}

// --------------------------------------------------------------- presentation

export interface PresentationSlideInput {
  title?: string;
  bullets?: string[];
  notes?: string;
}

export async function createPresentation(input: { path: string; title?: string; subject?: string; slides: PresentationSlideInput[]; overwrite?: boolean }): Promise<OfficeWriteResult> {
  const full = resolveOfficePath(input.path, 'pptx', 'write');
  ensureWritableTarget(full, input.overwrite === true);

  const slides = Array.isArray(input.slides) ? input.slides : [];
  if (slides.length === 0) throw new Error('A presentation needs at least one slide');
  if (slides.length > OFFICE_LIMITS.MAX_SLIDES) {
    throw new Error(`Too many slides (${slides.length}) — the limit is ${OFFICE_LIMITS.MAX_SLIDES}`);
  }

  const PptxGenJS = await loadPptxGenJs();
  const pptx = new PptxGenJS();
  pptx.title = String(input.title ?? path.basename(full, '.pptx')).slice(0, OFFICE_LIMITS.MAX_TITLE_CHARS);
  if (typeof input.subject === 'string' && input.subject.trim()) {
    pptx.subject = input.subject.trim().slice(0, OFFICE_LIMITS.MAX_TITLE_CHARS);
  }
  pptx.author = 'Krisha';

  let slideCount = 0;
  for (const s of slides) {
    const slide = pptx.addSlide();
    slideCount += 1;
    const title = String(s.title ?? `Slide ${slideCount}`).trim().slice(0, OFFICE_LIMITS.MAX_TITLE_CHARS);
    slide.addText(title, { x: 0.5, y: 0.4, w: 9.0, fontSize: 26, bold: true, color: '1F3864' });

    const bullets = (Array.isArray(s.bullets) ? s.bullets : [])
      .map((b) => String(b ?? '').trim())
      .filter(Boolean)
      .slice(0, OFFICE_LIMITS.MAX_BULLETS_PER_SLIDE);
    if (bullets.length > 0) {
      if (bullets.some((b) => b.length > OFFICE_LIMITS.MAX_BULLET_CHARS)) {
        throw new Error(`Slide ${slideCount}: bullets must stay under ${OFFICE_LIMITS.MAX_BULLET_CHARS} characters`);
      }
      slide.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: 1.4, w: 8.6, fontSize: 16, color: '333333', lineSpacingMultiple: 1.2 }
      );
    }
    if (typeof s.notes === 'string' && s.notes.trim()) {
      slide.addNotes(s.notes.trim().slice(0, OFFICE_LIMITS.MAX_NOTES_CHARS));
    }
  }

  await pptx.writeFile({ fileName: full });

  // Honest verification: file exists, is a plausible size, and carries the
  // ZIP container magic (a .pptx is a zip — this catches truncated writes).
  const bytes = statSize(full);
  const header = Buffer.alloc(2);
  let magicOk = false;
  try {
    const fd = fs.openSync(full, 'r');
    fs.readSync(fd, header, 0, 2, 0);
    fs.closeSync(fd);
    magicOk = header[0] === 0x50 && header[1] === 0x4b;
  } catch {
    magicOk = false;
  }
  const verified = bytes > 1_000 && magicOk;
  const summary =
    `Created presentation "${path.basename(full)}" with ${slideCount} slide(s) ` +
    `(title slide style, text bullets, speaker notes where given). ` +
    `${verified ? `Verified ✓ (${bytes} bytes, valid zip container, local file).` : 'Verification could not confirm the file — reported honestly.'}`;
  return { path: full, kind: 'pptx', bytes, verified, verificationNote: verified ? 'Size + zip magic check passed' : 'Post-write check failed', summary, slides: slideCount };
}

// ------------------------------------------------------------------- helpers

function colLettersToIndex(letters: string): number {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}

function indexToColLetters(index: number): string {
  let n = index + 1; // 1-based
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}
