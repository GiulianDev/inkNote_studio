// ============================================================
// EXPORT PDF (Livello 2: vettoriale + raster HD via pdf-lib) + FULLSCREEN
//
// Caratteristiche:
//   - Modale opzioni: Tutte le pagine / Solo pagina corrente,
//     Tema chiaro/scuro, toggle "Includi colore sfondo",
//     toggle "Includi righe / quadretti / punti".
//   - Sfondo e pattern (righe/quadretti/punti) disegnati come
//     vettori nativi PDF A4 (595.28 × 841.89 pt).
//   - Caselle di testo esportate come testo PDF vettoriale
//     selezionabile e ricercabile (fallback automatico a raster
//     trasparente per singoli box con emoji/caratteri non-WinAnsi).
//   - Inchiostro renderizzato in alta risoluzione (DPR 2) su un
//     singolo canvas offscreen trasparente riusato pagina per
//     pagina (memoria costante per Surface Go 1), senza mutare
//     lo stato o le cache live degli stroke.
// ============================================================

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { state } from '../../shared/core/state.js';
import { getSettings } from '../../shared/core/app-settings.js';
import { getCurrentNotebook } from '../../shared/persistence/session.js';
import { finalizePendingShape } from '../tools/shapes.js';
import { commitActiveTextBox } from '../tools/text.js';
import { closeAllEditorMenus } from '../toolbar/toolbar.js';
import {
  redrawPageCanvas,
  TEXT_PAD_X,
  TEXT_PAD_Y,
  TEXT_LINE_HEIGHT_MULT
} from '../render/render.js';
import {
  PAGE_WIDTH,
  PAGE_HEIGHT,
  parseHexRgb,
  isPaperDark,
  getEffectiveColor,
  escapeHtml,
  showToast
} from '../../shared/core/utils.js';
import { openModalOverlay } from '../../shared/components/modal.js';

const PDF_WIDTH = 595.28;   // A4 width in pt
const PDF_HEIGHT = 841.89;  // A4 height in pt
const EXPORT_DPR = 2;

function _rgbFromHex(hex, fallbackHex = '#000000') {
  const parsed = parseHexRgb(hex) || parseHexRgb(fallbackHex) || { r: 0, g: 0, b: 0 };
  return rgb(parsed.r / 255, parsed.g / 255, parsed.b / 255);
}

function _isNearWhite(hex) {
  const p = parseHexRgb(hex);
  if (!p) return false;
  return (0.299 * p.r + 0.587 * p.g + 0.114 * p.b) >= 235;
}

function _fontKeyForTextBox(tb) {
  const fam = tb?.fontFamily === 'serif' || tb?.fontFamily === 'mono' ? tb.fontFamily : 'sans';
  const bold = !!tb?.bold;
  const italic = !!tb?.italic;
  return `${fam}|${bold ? 1 : 0}|${italic ? 1 : 0}`;
}

function _standardFontName(fam, bold, italic) {
  if (fam === 'serif') {
    if (bold && italic) return StandardFonts.TimesRomanBoldItalic;
    if (bold) return StandardFonts.TimesRomanBold;
    if (italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (fam === 'mono') {
    if (bold && italic) return StandardFonts.CourierBoldOblique;
    if (bold) return StandardFonts.CourierBold;
    if (italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  // 'sans' e 'hand' usano Helvetica per wrapping/testo vettoriale affidabile
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

function _wrapTextForPdfFont(text, pdfFont, pdfFontSize, maxPdfWidth) {
  const paragraphs = (typeof text === 'string' ? text : '').split(/\r?\n/);
  const lines = [];

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    if (para === '') {
      lines.push('');
      continue;
    }

    const words = para.split(' ');
    let currentLine = '';

    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      const candidate = currentLine === '' ? word : `${currentLine} ${word}`;
      if (pdfFont.widthOfTextAtSize(candidate, pdfFontSize) <= maxPdfWidth) {
        currentLine = candidate;
      } else {
        if (currentLine !== '') {
          lines.push(currentLine);
          currentLine = '';
        }
        if (pdfFont.widthOfTextAtSize(word, pdfFontSize) <= maxPdfWidth) {
          currentLine = word;
        } else {
          let chunk = '';
          for (let c = 0; c < word.length; c++) {
            const ch = word[c];
            const nextChunk = chunk + ch;
            if (chunk !== '' && pdfFont.widthOfTextAtSize(nextChunk, pdfFontSize) > maxPdfWidth) {
              lines.push(chunk);
              chunk = ch;
            } else {
              chunk = nextChunk;
            }
          }
          currentLine = chunk;
        }
      }
    }
    lines.push(currentLine);
  }

  return lines.length > 0 ? lines : [''];
}

function _canFontEncodeText(pdfFont, text) {
  try {
    pdfFont.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

function _canvasToPngBytes(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error('Impossibile convertire la pagina in PNG'));
        return;
      }
      try {
        const buf = await blob.arrayBuffer();
        resolve(new Uint8Array(buf));
      } catch (err) {
        reject(err);
      }
    }, 'image/png');
  });
}

function _yieldFrame() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function _drawVectorPageBackground(pdfPage, options) {
  const { includeBackground, includePattern, themeDark } = options;
  const sx = PDF_WIDTH / PAGE_WIDTH;
  const sy = PDF_HEIGHT / PAGE_HEIGHT;

  const bgHex = includeBackground
    ? (state.paperColor || (themeDark ? '#1E293B' : '#FFFFFF'))
    : '#FFFFFF';

  if (includeBackground && bgHex.toLowerCase() !== '#ffffff') {
    pdfPage.drawRectangle({
      x: 0,
      y: 0,
      width: PDF_WIDTH,
      height: PDF_HEIGHT,
      color: _rgbFromHex(bgHex)
    });
  }

  if (!includePattern || state.bgPattern === 'blank') return;

  // Se lo sfondo è stato rimosso (carta bianca), evita linee bianche/invisibili
  const safeCustomPattern = (!includeBackground && state.patternColor && _isNearWhite(state.patternColor))
    ? null
    : state.patternColor;

  const useDarkPalette = includeBackground ? themeDark : false;
  const lineHex = safeCustomPattern || (useDarkPalette ? '#334155' : '#E2E8F0');
  const dotHex  = safeCustomPattern || (useDarkPalette ? '#475569' : '#94A3B8');

  const ruledMarginX = 44;
  const ruledMaxY = PAGE_HEIGHT - 48;

  if (state.bgPattern === 'ruled') {
    const color = _rgbFromHex(lineHex, '#E2E8F0');
    const thickness = Math.max(0.5, 1 * sy);
    const startX = ruledMarginX * sx;
    const endX = (PAGE_WIDTH - ruledMarginX) * sx;
    for (let y = 60; y <= ruledMaxY; y += 32) {
      const py = PDF_HEIGHT - y * sy;
      pdfPage.drawLine({
        start: { x: startX, y: py },
        end: { x: endX, y: py },
        thickness,
        color
      });
    }
  } else if (state.bgPattern === 'grid') {
    const color = _rgbFromHex(lineHex, '#E2E8F0');
    const thickX = Math.max(0.5, 1 * sx);
    const thickY = Math.max(0.5, 1 * sy);
    const gridMinX = 50;
    const gridMaxX = 750;
    const gridMinY = 50;
    const gridMaxY = 1075;
    const pdfGridMinX = gridMinX * sx;
    const pdfGridMaxX = gridMaxX * sx;
    const pdfGridTopY = PDF_HEIGHT - gridMinY * sy;
    const pdfGridBotY = PDF_HEIGHT - gridMaxY * sy;
    for (let x = gridMinX; x <= gridMaxX; x += 25) {
      const px = x * sx;
      pdfPage.drawLine({
        start: { x: px, y: pdfGridBotY },
        end: { x: px, y: pdfGridTopY },
        thickness: thickX,
        color
      });
    }
    for (let y = gridMinY; y <= gridMaxY; y += 25) {
      const py = PDF_HEIGHT - y * sy;
      pdfPage.drawLine({
        start: { x: pdfGridMinX, y: py },
        end: { x: pdfGridMaxX, y: py },
        thickness: thickY,
        color
      });
    }
  } else if (state.bgPattern === 'dots') {
    const color = _rgbFromHex(dotHex, '#94A3B8');
    const r = 1.2 * sx;
    for (let x = 40; x <= PAGE_WIDTH - 34; x += 20) {
      const px = x * sx;
      for (let y = 44; y <= PAGE_HEIGHT - 47; y += 24) {
        pdfPage.drawCircle({
          x: px,
          y: PDF_HEIGHT - y * sy,
          size: r,
          color
        });
      }
    }
  }
}

async function _buildPdfDocument(pagesToExport, options, onProgress) {
  const { includeBackground, themeDark } = options;
  const effectiveInkDark = includeBackground ? isPaperDark(themeDark, state.paperColor) : false;
  const sx = PDF_WIDTH / PAGE_WIDTH;
  const sy = PDF_HEIGHT / PAGE_HEIGHT;

  const pdfDoc = await PDFDocument.create();
  const nb = getCurrentNotebook();
  if (nb?.title) {
    try { pdfDoc.setTitle(String(nb.title)); } catch {}
  }
  try { pdfDoc.setCreator('InkNote Studio'); } catch {}

  const fontCache = new Map();
  const getFontForTextBox = async (tb) => {
    const key = _fontKeyForTextBox(tb);
    if (fontCache.has(key)) return fontCache.get(key);
    const fam = tb?.fontFamily === 'serif' || tb?.fontFamily === 'mono' ? tb.fontFamily : 'sans';
    const stdName = _standardFontName(fam, !!tb?.bold, !!tb?.italic);
    const font = await pdfDoc.embedFont(stdName);
    fontCache.set(key, font);
    return font;
  };

  // Un solo canvas offscreen riusato su tutte le pagine per contenere la RAM (Surface Go 1)
  const offCanvas = document.createElement('canvas');
  offCanvas.width = Math.floor(PAGE_WIDTH * EXPORT_DPR);
  offCanvas.height = Math.floor(PAGE_HEIGHT * EXPORT_DPR);
  const offCtx = offCanvas.getContext('2d');

  try {
    for (let idx = 0; idx < pagesToExport.length; idx++) {
      const pageData = pagesToExport[idx];
      if (onProgress) onProgress(idx + 1, pagesToExport.length);

      const pdfPage = pdfDoc.addPage([PDF_WIDTH, PDF_HEIGHT]);
      _drawVectorPageBackground(pdfPage, options);

      const textBoxes = Array.isArray(pageData.textBoxes) ? pageData.textBoxes : [];
      const vectorBoxes = [];
      const fallbackTextIds = new Set();

      for (let i = 0; i < textBoxes.length; i++) {
        const tb = textBoxes[i];
        if (!tb || typeof tb.text !== 'string' || tb.text.trim() === '') continue;
        const pdfFont = await getFontForTextBox(tb);
        // Prova l'encoding WinAnsi su tutto il testo (rimuovendo \r\n che non sono glifi)
        const testText = tb.text.replace(/\r?\n/g, ' ');
        if (_canFontEncodeText(pdfFont, testText)) {
          vectorBoxes.push({ tb, pdfFont });
        } else if (tb.id) {
          fallbackTextIds.add(tb.id);
        }
      }

      const hasStrokes = Array.isArray(pageData.strokes) && pageData.strokes.length > 0;
      const hasFallbackText = fallbackTextIds.size > 0;

      if (hasStrokes || hasFallbackText) {
        const fake = {
          canvas: offCanvas,
          ctx: offCtx,
          dpr: EXPORT_DPR,
          overlayCanvas: null,
          overlayCtx: null,
          overlayDpr: 0,
          strokes: pageData.strokes || [],
          textBoxes,
          _isExport: true,
          index: pageData.index,
          wrapper: pageData.wrapper
        };

        redrawPageCanvas(fake, themeDark, {
          skipBackground: true,
          skipTextBoxes: !hasFallbackText,
          textBoxFilter: hasFallbackText ? (tb) => fallbackTextIds.has(tb.id) : null,
          inkDark: effectiveInkDark
        });

        const pngBytes = await _canvasToPngBytes(offCanvas);
        const pngImage = await pdfDoc.embedPng(pngBytes);
        pdfPage.drawImage(pngImage, {
          x: 0,
          y: 0,
          width: PDF_WIDTH,
          height: PDF_HEIGHT
        });
      }

      // Disegna le caselle di testo come testo vettoriale PDF selezionabile
      for (let i = 0; i < vectorBoxes.length; i++) {
        const { tb, pdfFont } = vectorBoxes[i];
        const width = Math.max(80, tb.width || 240);
        const fontSize = Math.max(10, Math.min(72, tb.fontSize || 18));
        const pdfFontSize = fontSize * sy;
        const lineHeight = fontSize * TEXT_LINE_HEIGHT_MULT;
        const topOffset = (lineHeight - fontSize) * 0.5;
        const maxPdfW = Math.max(10, (width - TEXT_PAD_X * 2) * sx);
        const lines = _wrapTextForPdfFont(tb.text, pdfFont, pdfFontSize, maxPdfW);
        const align = tb.align === 'center' || tb.align === 'right' ? tb.align : 'left';
        const effectiveHex = getEffectiveColor(tb.color || '#000000', effectiveInkDark);
        const color = _rgbFromHex(effectiveHex, effectiveInkDark ? '#FFFFFF' : '#000000');

        for (let l = 0; l < lines.length; l++) {
          const line = lines[l];
          if (line === '') continue;

          let xPdf = (tb.x + TEXT_PAD_X) * sx;
          if (align === 'center') {
            const lineW = pdfFont.widthOfTextAtSize(line, pdfFontSize);
            xPdf = (tb.x + width / 2) * sx - lineW / 2;
          } else if (align === 'right') {
            const lineW = pdfFont.widthOfTextAtSize(line, pdfFontSize);
            xPdf = (tb.x + width - TEXT_PAD_X) * sx - lineW;
          }

          const canvasTopY = tb.y + TEXT_PAD_Y + topOffset + l * lineHeight;
          const baselineY = PDF_HEIGHT - (canvasTopY + fontSize * 0.82) * sy;

          pdfPage.drawText(line, {
            x: xPdf,
            y: baselineY,
            size: pdfFontSize,
            font: pdfFont,
            color
          });
        }
      }

      if (idx < pagesToExport.length - 1) {
        await _yieldFrame();
      }
    }
  } finally {
    offCanvas.width = 0;
    offCanvas.height = 0;
  }

  return pdfDoc.save();
}

function _triggerPdfDownload(pdfBytes, filename) {
  const blob = new Blob([pdfBytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

export function exportToPDF() {
  closeAllEditorMenus();
  if (state.pendingShape) finalizePendingShape();
  if (state.editingTextBoxId || state.selectedTextBoxId) {
    commitActiveTextBox({ deselect: true });
  }
  if (!state.pages || state.pages.length === 0) {
    showToast('Nessuna pagina da esportare', '⚠️');
    return;
  }
  if (document.getElementById('exportPdfModal')) return;

  const settings = getSettings();
  const totalPages = state.pages.length;
  const currentIdx = Math.max(0, Math.min(totalPages - 1, state.activePageIndex || 0));
  const defaultTheme = settings.printTheme === 'dark' ? 'dark' : 'light';
  const hasPattern = state.bgPattern && state.bgPattern !== 'blank';

  const patternLabels = {
    ruled: 'righe',
    grid: 'quadretti',
    dots: 'punti',
    blank: 'foglio bianco'
  };
  const patternLabel = patternLabels[state.bgPattern] || 'pattern';

  const overlay = document.createElement('div');
  overlay.id = 'exportPdfModal';
  overlay.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');

  overlay.innerHTML = `
    <div class="bg-white dark:bg-slate-900 rounded-2xl max-w-md w-full shadow-2xl border border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden">
      <div class="px-5 pt-5 pb-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between">
        <div>
          <h3 class="text-base font-bold text-slate-900 dark:text-white">Esporta PDF</h3>
          <p class="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">Testo vettoriale selezionabile e inchiostro HD</p>
        </div>
        <button type="button" id="exportPdfCloseBtn" style="touch-action: manipulation;"
          class="w-8 h-8 rounded-lg flex items-center justify-center text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition cursor-pointer"
          aria-label="Chiudi">
          <svg class="w-4 h-4 pointer-events-none" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div class="p-5 space-y-4 text-xs">
        <div>
          <span class="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Pagine</span>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 cursor-pointer has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/70 dark:has-[:checked]:bg-indigo-950/40">
              <input type="radio" name="exportPdfScope" value="all" checked class="accent-indigo-600">
              <span class="font-medium text-slate-800 dark:text-slate-200">Tutte (${totalPages})</span>
            </label>
            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 cursor-pointer has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/70 dark:has-[:checked]:bg-indigo-950/40">
              <input type="radio" name="exportPdfScope" value="current" class="accent-indigo-600">
              <span class="font-medium text-slate-800 dark:text-slate-200">Corrente (${currentIdx + 1}/${totalPages})</span>
            </label>
          </div>
        </div>

        <div>
          <span class="block font-semibold text-slate-700 dark:text-slate-300 mb-1.5">Tema</span>
          <div class="grid grid-cols-2 gap-2">
            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 cursor-pointer has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/70 dark:has-[:checked]:bg-indigo-950/40">
              <input type="radio" name="exportPdfTheme" value="light" ${defaultTheme === 'light' ? 'checked' : ''} class="accent-indigo-600">
              <span class="font-medium text-slate-800 dark:text-slate-200">Chiaro (stampa)</span>
            </label>
            <label class="flex items-center gap-2 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800/60 cursor-pointer has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/70 dark:has-[:checked]:bg-indigo-950/40">
              <input type="radio" name="exportPdfTheme" value="dark" ${defaultTheme === 'dark' ? 'checked' : ''} class="accent-indigo-600">
              <span class="font-medium text-slate-800 dark:text-slate-200">Scuro (schermo)</span>
            </label>
          </div>
        </div>

        <div class="space-y-2 pt-1">
          <label class="flex items-start justify-between gap-3 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/40 cursor-pointer">
            <div>
              <div class="font-semibold text-slate-800 dark:text-slate-200">Includi colore sfondo</div>
              <div class="text-[11px] text-slate-500 dark:text-slate-400">Disattiva per ottenere foglio bianco e risparmiare inchiostro</div>
            </div>
            <input type="checkbox" id="exportPdfIncludeBg" checked class="mt-0.5 w-4 h-4 accent-indigo-600 rounded cursor-pointer shrink-0">
          </label>

          <label class="flex items-start justify-between gap-3 p-2.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-800/40 ${hasPattern ? 'cursor-pointer' : 'opacity-60 cursor-not-allowed'}">
            <div>
              <div class="font-semibold text-slate-800 dark:text-slate-200">Includi ${escapeHtml(patternLabel)}</div>
              <div class="text-[11px] text-slate-500 dark:text-slate-400">${hasPattern ? 'Disattiva per esportare senza griglia o righe' : 'Il quaderno usa già sfondo bianco pulito'}</div>
            </div>
            <input type="checkbox" id="exportPdfIncludePattern" ${hasPattern ? 'checked' : 'disabled'} class="mt-0.5 w-4 h-4 accent-indigo-600 rounded shrink-0 ${hasPattern ? 'cursor-pointer' : ''}">
          </label>
        </div>

        <p id="exportPdfHint" class="hidden text-[11px] text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/60 rounded-xl px-3 py-2 leading-relaxed"></p>

        <div id="exportPdfProgressBox" class="hidden space-y-1.5 pt-1">
          <div class="flex items-center justify-between text-[11px] font-semibold text-slate-600 dark:text-slate-300">
            <span id="exportPdfProgressText">Preparazione PDF...</span>
            <span id="exportPdfProgressPct" class="tabular-nums">0%</span>
          </div>
          <div class="w-full h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div id="exportPdfProgressBar" class="h-full bg-indigo-600 transition-all duration-150" style="width: 0%"></div>
          </div>
        </div>
      </div>

      <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-slate-100 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60">
        <button type="button" id="exportPdfCancelBtn" style="touch-action: manipulation;"
          class="px-3.5 py-2 rounded-xl text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 font-semibold text-xs transition cursor-pointer">
          Annulla
        </button>
        <button type="button" id="exportPdfConfirmBtn" style="touch-action: manipulation;"
          class="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-xs shadow-sm transition cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
          Scarica PDF
        </button>
      </div>
    </div>
  `;

  let isExporting = false;

  const includeBgInput = overlay.querySelector('#exportPdfIncludeBg');
  const includePatternInput = overlay.querySelector('#exportPdfIncludePattern');
  const hintEl = overlay.querySelector('#exportPdfHint');
  const progressBox = overlay.querySelector('#exportPdfProgressBox');
  const progressText = overlay.querySelector('#exportPdfProgressText');
  const progressPct = overlay.querySelector('#exportPdfProgressPct');
  const progressBar = overlay.querySelector('#exportPdfProgressBar');
  const confirmBtn = overlay.querySelector('#exportPdfConfirmBtn');
  const cancelBtn = overlay.querySelector('#exportPdfCancelBtn');
  const closeBtn = overlay.querySelector('#exportPdfCloseBtn');

  const updateHint = () => {
    const themeVal = overlay.querySelector('input[name="exportPdfTheme"]:checked')?.value || 'light';
    const includeBg = !!includeBgInput?.checked;
    const themeDark = themeVal === 'dark';
    const paperIsDark = isPaperDark(themeDark, state.paperColor);

    if (!includeBg && paperIsDark) {
      hintEl.textContent = 'Senza sfondo, il PDF userà carta bianca e adatterà automaticamente inchiostro e testo in scuro per mantenerli leggibili.';
      hintEl.classList.remove('hidden');
    } else if (includeBg && state.paperColor && isPaperDark(themeDark, state.paperColor)) {
      hintEl.textContent = 'Il foglio ha uno sfondo scuro: per stampare risparmiando inchiostro puoi disattivare "Includi colore sfondo".';
      hintEl.classList.remove('hidden');
    } else {
      hintEl.classList.add('hidden');
    }
  };

  overlay.querySelectorAll('input[name="exportPdfTheme"], #exportPdfIncludeBg').forEach(el => {
    el.addEventListener('change', updateHint);
  });
  updateHint();

  const modalCtrl = openModalOverlay(overlay, {
    id: 'exportPdfModal',
    ariaLabel: 'Esporta PDF',
    canClose: () => !isExporting
  });

  const close = () => {
    modalCtrl.close('cancel');
  };

  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);

  confirmBtn.addEventListener('click', async () => {
    if (isExporting) return;
    isExporting = true;

    const scope = overlay.querySelector('input[name="exportPdfScope"]:checked')?.value === 'current'
      ? 'current'
      : 'all';
    const themeMode = overlay.querySelector('input[name="exportPdfTheme"]:checked')?.value === 'dark'
      ? 'dark'
      : 'light';
    const includeBackground = !!includeBgInput?.checked;
    const includePattern = hasPattern && !!includePatternInput?.checked;

    const pagesToExport = scope === 'current'
      ? [state.pages[currentIdx]].filter(Boolean)
      : state.pages;

    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    closeBtn.disabled = true;
    overlay.querySelectorAll('input').forEach(i => { i.disabled = true; });
    progressBox.classList.remove('hidden');

    try {
      const pdfBytes = await _buildPdfDocument(
        pagesToExport,
        { includeBackground, includePattern, themeDark: themeMode === 'dark' },
        (done, total) => {
          const pct = Math.round((done / Math.max(1, total)) * 100);
          progressText.textContent = `Esportazione pagina ${done} di ${total}...`;
          progressPct.textContent = `${pct}%`;
          progressBar.style.width = `${pct}%`;
        }
      );

      const rawTitle = (getCurrentNotebook()?.title || 'quaderno').trim() || 'quaderno';
      const safeTitle = rawTitle.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').slice(0, 80);
      const filename = scope === 'current'
        ? `${safeTitle} - Pagina ${currentIdx + 1}.pdf`
        : `${safeTitle}.pdf`;

      _triggerPdfDownload(pdfBytes, filename);
      showToast('PDF esportato con successo', '📄');
      isExporting = false;
      close();
    } catch (err) {
      console.error('Errore esportazione PDF:', err);
      showToast('Errore durante la creazione del PDF', '⚠️');
      isExporting = false;
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      closeBtn.disabled = false;
      overlay.querySelectorAll('input').forEach(i => {
        if (i.id === 'exportPdfIncludePattern' && !hasPattern) return;
        i.disabled = false;
      });
      progressBox.classList.add('hidden');
    }
  });
}