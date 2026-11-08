import type { ShapeEl, Slide } from '@shared/deck.js';
import { annotationStroke } from '@shared/annotations.js';
import type { XY } from '@shared/pathNodes.js';
import type { AnnotationOverlay } from '@shared/ipc.js';
import { button } from '../editor/ui.js';
import { eventOnInteractiveWeb, slideLinkFromEvent } from './links.js';
import './annotationTools.css';

type Mode = 'navigate' | 'pen' | 'laser';
export const LASER_HOLD_MS = 500;
const HOLD_SLOP_PX = 8;
export const PEN_COLORS = [
  ['Red', '#e53935'], ['Blue', '#1976d2'], ['Green', '#2e7d32'], ['Yellow', '#fdd835'],
  ['Orange', '#f57c00'], ['Purple', '#8e24aa'], ['Black', '#111111'], ['White', '#ffffff'],
] as const;
export const PEN_WIDTHS = [1, 2, 4, 6, 8, 12, 20] as const;
const PEN_PREFERENCE = 'deckwerk.annotation.pen';
type PenStyle = { color: string; width: number };

function storedPenStyle(): PenStyle {
  try {
    const value = JSON.parse(localStorage.getItem(PEN_PREFERENCE) ?? '{}');
    return {
      color: PEN_COLORS.some(([, color]) => color === value?.color) ? value.color : '#e53935',
      width: PEN_WIDTHS.some((width) => width === value?.width) ? value.width : 4,
    };
  } catch { return { color: '#e53935', width: 4 }; }
}
interface PointerGesture {
  id: number; slideId: string; points: XY[]; kind: 'ink' | 'waiting' | 'laser';
  origin: XY; timer: ReturnType<typeof setTimeout> | null;
  pen: PenStyle;
}
export interface AnnotationToolsOptions {
  host: HTMLElement;
  toolbarHost?: HTMLElement;
  onOverlay?: (overlay: AnnotationOverlay) => void;
  slide(): { slide: Slide; canvas: { w: number; h: number } } | null;
  /** Commit through the editor/collaboration store, never overwrite the deck. */
  save(slideId: string, stroke: ShapeEl): void;
}

/** Presentation-only chrome; ink itself uses the normal slide renderer. */
export function createAnnotationTools(options: AnnotationToolsOptions): {
  destroy(): void; reset(): void; setToolbarVisible(visible: boolean): void; showOverlay(overlay: AnnotationOverlay): void;
} {
  const { host } = options;
  let mode: Mode = 'navigate';
  let active: PointerGesture | null = null;
  let suppressNextClick = false;
  let pen = storedPenStyle();
  const layer = document.createElement('div');
  layer.className = 'annotation-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('annotation-preview');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', pen.color);
  path.setAttribute('stroke-width', String(pen.width));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  const laser = document.createElement('div');
  laser.className = 'presentation-laser';
  laser.hidden = true;
  layer.append(svg, laser);
  const toolbar = document.createElement('div');
  toolbar.className = 'annotation-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Presentation tools');
  const controls = (['navigate', 'pen', 'laser'] as const).map((value) => {
    const label = { navigate: 'Navigate', pen: 'Pen', laser: 'Laser' }[value];
    const control = button(label, () => setMode(value), { variant: 'quiet' });
    control.title = value === 'pen' ? 'Draw and save annotations (P). Hold still for a temporary laser.'
      : value === 'laser' ? 'Laser pointer (L); hold Ctrl to point temporarily' : 'Navigate slides (V)';
    control.dataset.annotationMode = value;
    toolbar.append(control);
    return control;
  });
  const setting = (label: string, entries: Array<[string, string]>, value: string): HTMLSelectElement => {
    const field = document.createElement('label');
    field.className = 'annotation-setting';
    const name = document.createElement('span');
    name.textContent = label;
    const select = document.createElement('select');
    select.setAttribute('aria-label', `Pen ${label.toLowerCase()}`);
    for (const [text, optionValue] of entries) {
      const option = document.createElement('option');
      option.textContent = text; option.value = optionValue;
      select.append(option);
    }
    select.value = value;
    // Dropdown arrow keys edit the setting rather than changing slides.
    select.addEventListener('keydown', (event) => event.stopPropagation());
    field.append(name, select);
    toolbar.append(field);
    return select;
  };
  const colorSelect = setting('Color', PEN_COLORS.map(([name, value]) => [name, value]), pen.color);
  const widthSelect = setting('Width', PEN_WIDTHS.map((width) => [`${width} px`, String(width)]), String(pen.width));
  const updatePen = (): void => {
    cancel();
    pen = {
      color: PEN_COLORS.some(([, color]) => color === colorSelect.value) ? colorSelect.value : pen.color,
      width: PEN_WIDTHS.some((width) => width === Number(widthSelect.value)) ? Number(widthSelect.value) : pen.width,
    };
    path.setAttribute('stroke', pen.color);
    path.setAttribute('stroke-width', String(pen.width));
    try { localStorage.setItem(PEN_PREFERENCE, JSON.stringify(pen)); } catch { /* Private browsing still permits drawing. */ }
  };
  colorSelect.addEventListener('change', updatePen);
  widthSelect.addEventListener('change', updatePen);
  const cancel = (): void => {
    const id = active?.id;
    if (active?.timer !== null && active?.timer !== undefined) clearTimeout(active.timer);
    active = null;
    path.removeAttribute('d');
    layer.classList.toggle('annotation-active', mode !== 'navigate');
    layer.classList.toggle('laser-active', mode === 'laser');
    laser.hidden = true;
    emitOverlay();
    if (id !== undefined && host.hasPointerCapture?.(id)) host.releasePointerCapture(id);
  };
  function setMode(next: Mode): void {
    cancel();
    mode = next;
    layer.classList.toggle('annotation-active', next !== 'navigate');
    layer.classList.toggle('laser-active', next === 'laser');
    laser.hidden = true;
    controls.forEach((control) => control.setAttribute('aria-pressed', String(control.dataset.annotationMode === next)));
  }
  setMode('navigate');
  host.classList.add('annotation-enabled');
  host.append(layer);
  (options.toolbarHost ?? host).append(toolbar);
  // Keep presentation navigation and fullscreen handlers away from tool clicks.
  const stop = (event: Event): void => event.stopPropagation();
  for (const type of ['pointerdown', 'pointerup', 'click', 'dblclick', 'mousedown']) toolbar.addEventListener(type, stop);
  const position = (event: PointerEvent): XY | null => {
    const state = options.slide();
    const rect = host.querySelector('.stage')?.getBoundingClientRect();
    if (!state || !rect || !rect.width || !rect.height) return null;
    const hostRect = host.getBoundingClientRect();
    svg.style.left = `${rect.left - hostRect.left}px`;
    svg.style.top = `${rect.top - hostRect.top}px`;
    svg.style.width = `${rect.width}px`;
    svg.style.height = `${rect.height}px`;
    svg.setAttribute('viewBox', `0 0 ${state.canvas.w} ${state.canvas.h}`);
    return {
      x: Math.max(0, Math.min(state.canvas.w, (event.clientX - rect.left) * state.canvas.w / rect.width)),
      y: Math.max(0, Math.min(state.canvas.h, (event.clientY - rect.top) * state.canvas.h / rect.height)),
    };
  };
  const consume = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const isToolEvent = (event: Event): boolean => toolbar.contains(event.target as Node);
  function emitOverlay(point: XY | null = null): void {
    const slide = options.slide();
    if (!slide || !options.onOverlay) return;
    options.onOverlay({ slideId: slide.slide.id, laser: point, points: active?.kind === 'ink' ? [...active.points] : [], pen: active?.pen ?? pen });
  }
  const pointLaser = (point: XY): void => {
    const rect = host.getBoundingClientRect();
    laser.style.left = `${point.x - rect.left}px`;
    laser.style.top = `${point.y - rect.top}px`;
    laser.hidden = false;
    const state = options.slide();
    const stage = host.querySelector('.stage')?.getBoundingClientRect();
    if (state && stage?.width && stage.height) emitOverlay({
      x: (point.x - stage.left) * state.canvas.w / stage.width,
      y: (point.y - stage.top) * state.canvas.h / stage.height,
    });
  };
  const down = (event: PointerEvent): void => {
    if (isToolEvent(event) || event.button !== 0) return;
    if (active) { consume(event); return; }
    suppressNextClick = false;
    if (mode === 'laser' || event.ctrlKey) { consume(event); move(event); return; }
    if (mode === 'navigate' && (slideLinkFromEvent(event) || eventOnInteractiveWeb(event)
        || (event.target instanceof Element && event.target.closest('button, input, textarea, select, [contenteditable="true"]')))) return;
    const state = options.slide();
    const point = position(event);
    if (!state || !point) return;
    const drawing = event.pointerType === 'pen' || (mode === 'pen' && event.pointerType !== 'touch');
    if (drawing || mode === 'pen') {
      consume(event);
      if (document.activeElement instanceof HTMLElement && toolbar.contains(document.activeElement)) document.activeElement.blur();
    }
    const draft: PointerGesture = {
      id: event.pointerId, slideId: state.slide.id, points: [point], kind: drawing ? 'ink' : 'waiting',
      origin: { x: event.clientX, y: event.clientY }, timer: null,
      pen: { ...pen },
    };
    active = draft;
    path.setAttribute('stroke', draft.pen.color);
    path.setAttribute('stroke-width', String(draft.pen.width));
    if (drawing) host.setPointerCapture(event.pointerId);
    draft.timer = setTimeout(() => {
      if (active !== draft) return;
      draft.timer = null;
      if (options.slide()?.slide.id !== draft.slideId) { cancel(); return; }
      draft.kind = 'laser';
      draft.points = [];
      path.removeAttribute('d');
      suppressNextClick = true;
      host.setPointerCapture(draft.id);
      layer.classList.add('annotation-active', 'laser-active');
      pointLaser(draft.origin);
    }, LASER_HOLD_MS);
  };
  const move = (event: PointerEvent): void => {
    if (active) {
      if (event.pointerId !== active.id) { consume(event); return; }
      if (options.slide()?.slide.id !== active.slideId) { cancel(); return; }
      if (active.kind === 'laser') {
        consume(event);
        pointLaser({ x: event.clientX, y: event.clientY });
        return;
      }
      const samples = event.getCoalescedEvents?.() ?? [];
      for (const sample of samples.length ? samples : [event]) {
        if (Math.hypot(sample.clientX - active.origin.x, sample.clientY - active.origin.y) > HOLD_SLOP_PX) {
          if (active.timer !== null) clearTimeout(active.timer);
          active.timer = null;
          // A drag in Navigate retains native text selection and touch swipes.
          if (active.kind === 'waiting') { cancel(); return; }
        }
        const point = position(sample);
        if (point) active.points.push(point);
      }
      if (active.kind === 'waiting') return;
      consume(event);
      path.setAttribute('d', active.points.map((point, index) => `${index ? 'L' : 'M'} ${point.x} ${point.y}`).join(' '));
      emitOverlay();
    } else if (!isToolEvent(event) && (mode === 'laser' || event.ctrlKey)) {
      consume(event);
      pointLaser({ x: event.clientX, y: event.clientY });
    } else laser.hidden = true;
  };
  const up = (event: PointerEvent): void => {
    if (!active || event.pointerId !== active.id) return;
    if (active.kind !== 'waiting' || mode === 'pen') consume(event);
    const point = position(event);
    if (point) active.points.push(point);
    const draft = active;
    const state = options.slide();
    cancel();
    if (draft.kind !== 'ink' || state?.slide.id !== draft.slideId) return;
    const stroke = annotationStroke(state.slide, draft.points, draft.pen.color, draft.pen.width);
    if (stroke) options.save(draft.slideId, stroke);
  };
  const suppressClick = (event: MouseEvent): void => {
    if (!isToolEvent(event) && (suppressNextClick || mode !== 'navigate' || event.ctrlKey
        || (event.type === 'contextmenu' && active !== null) || (event as PointerEvent).pointerType === 'pen')) {
      consume(event);
    }
  };
  const key = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target?.isContentEditable || target?.closest?.('input, textarea, select') || event.metaKey || event.ctrlKey || event.altKey) return;
    const next = ({ p: 'pen', l: 'laser', v: 'navigate' } as Record<string, Mode>)[event.key.toLowerCase()];
    if (next) { consume(event); setMode(mode === next ? 'navigate' : next); }
    else if (event.key === 'Escape' && (mode !== 'navigate' || active)) { consume(event); setMode('navigate'); }
  };
  const leave = (): void => {
    if (active?.kind === 'waiting') cancel();
    laser.hidden = true;
    emitOverlay();
  };
  const keyup = (event: KeyboardEvent): void => { if (event.key === 'Control' && mode !== 'laser') leave(); };
  const blur = (): void => { cancel(); leave(); };
  const cancelled = (event: PointerEvent): void => { if (active?.id === event.pointerId) cancel(); };
  host.addEventListener('pointerdown', down, true);
  host.addEventListener('pointermove', move, true);
  host.addEventListener('pointerup', up, true);
  host.addEventListener('pointercancel', cancelled, true);
  host.addEventListener('lostpointercapture', cancelled, true);
  host.addEventListener('click', suppressClick, true);
  host.addEventListener('mousedown', suppressClick, true);
  host.addEventListener('dblclick', suppressClick, true);
  host.addEventListener('contextmenu', suppressClick, true);
  host.addEventListener('pointerleave', leave);
  window.addEventListener('keydown', key, true);
  window.addEventListener('keyup', keyup, true);
  window.addEventListener('blur', blur);
  return {
    reset: cancel,
    setToolbarVisible(visible) { toolbar.hidden = !visible; },
    showOverlay(overlay) {
      path.removeAttribute('d');
      laser.hidden = true;
      const state = options.slide();
      const rect = host.querySelector('.stage')?.getBoundingClientRect();
      if (!state || state.slide.id !== overlay.slideId || !rect?.width || !rect.height) return;
      const bounds = host.getBoundingClientRect();
      svg.style.left = `${rect.left - bounds.left}px`; svg.style.top = `${rect.top - bounds.top}px`;
      svg.style.width = `${rect.width}px`; svg.style.height = `${rect.height}px`;
      svg.setAttribute('viewBox', `0 0 ${state.canvas.w} ${state.canvas.h}`);
      path.setAttribute('stroke', /^#[0-9a-f]{6}$/i.test(overlay.pen?.color ?? '') ? overlay.pen!.color : '#e53935');
      path.setAttribute('stroke-width', String(overlay.pen && Number.isFinite(overlay.pen.width) ? Math.max(1, Math.min(20, overlay.pen.width)) : 4));
      if (overlay.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) {
        path.setAttribute('d', overlay.points.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' '));
      }
      if (overlay.laser && Number.isFinite(overlay.laser.x) && Number.isFinite(overlay.laser.y)) {
        laser.style.left = `${rect.left - bounds.left + overlay.laser.x * rect.width / state.canvas.w}px`;
        laser.style.top = `${rect.top - bounds.top + overlay.laser.y * rect.height / state.canvas.h}px`;
        laser.hidden = false;
      }
    },
    destroy() {
    blur();
    host.removeEventListener('pointerdown', down, true);
    host.removeEventListener('pointermove', move, true);
    host.removeEventListener('pointerup', up, true);
    host.removeEventListener('pointercancel', cancelled, true);
    host.removeEventListener('lostpointercapture', cancelled, true);
    host.removeEventListener('click', suppressClick, true);
    host.removeEventListener('mousedown', suppressClick, true);
    host.removeEventListener('dblclick', suppressClick, true);
    host.removeEventListener('contextmenu', suppressClick, true);
    host.removeEventListener('pointerleave', leave);
    window.removeEventListener('keydown', key, true);
    window.removeEventListener('keyup', keyup, true);
    window.removeEventListener('blur', blur);
    host.classList.remove('annotation-enabled');
    layer.remove(); toolbar.remove();
  } };
}
