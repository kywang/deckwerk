import type { ShapeEl, Slide } from '@shared/deck.js';
import { annotationStroke } from '@shared/annotations.js';
import type { XY } from '@shared/pathNodes.js';
import type { AnnotationOverlay } from '@shared/ipc.js';
import { button } from '../editor/ui.js';
import { eventOnInteractiveWeb, slideLinkFromEvent } from './links.js';
import { LiveInk } from './liveInk.js';
import { makeId } from '@shared/geometry.js';
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
  stream: string;
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
  let frame: number | null = null;
  let painted = 0;
  let sent = 0;
  let laserPoint: XY | null = null;
  let remote: AnnotationOverlay | null = null;
  let remotePoints: XY[] = [];
  let remoteStream: string | null = null;
  let remotePainted = 0;
  let projection: { left: number; top: number; width: number; height: number; hostLeft: number; hostTop: number; w: number; h: number } | null = null;
  const layer = document.createElement('div');
  layer.className = 'annotation-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('annotation-preview');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', pen.color);
  path.setAttribute('stroke-width', String(pen.width));
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  const ink = new LiveInk(path);
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
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    painted = sent = remotePainted = 0;
    remote = null; remotePoints = []; remoteStream = null;
    projection = null; laserPoint = null;
    ink.clear();
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
  function measure() {
    if (projection) return projection;
    const state = options.slide();
    const rect = host.querySelector('.stage')?.getBoundingClientRect();
    if (!state || !rect?.width || !rect.height) return null;
    const hostRect = host.getBoundingClientRect();
    projection = { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      hostLeft: hostRect.left, hostTop: hostRect.top, w: state.canvas.w, h: state.canvas.h };
    svg.style.left = `${rect.left - hostRect.left}px`;
    svg.style.top = `${rect.top - hostRect.top}px`;
    svg.style.width = `${rect.width}px`; svg.style.height = `${rect.height}px`;
    svg.setAttribute('viewBox', `0 0 ${state.canvas.w} ${state.canvas.h}`);
    return projection;
  }
  const position = (event: MouseEvent): XY | null => {
    const p = measure();
    return p ? { x: Math.max(0, Math.min(p.w, (event.clientX - p.left) * p.w / p.width)),
      y: Math.max(0, Math.min(p.h, (event.clientY - p.top) * p.h / p.height)) } : null;
  };
  const consume = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation(); };
  const isToolEvent = (event: Event): boolean => toolbar.contains(event.target as Node);
  // Clears are immediate, so a queued frame cannot resurrect a cancelled stroke.
  function emitOverlay(): void {
    const slide = options.slide();
    if (slide && options.onOverlay) options.onOverlay({ slideId: slide.slide.id, laser: null, points: [], pen });
  }
  function schedule(): void {
    if (frame !== null) return;
    frame = requestAnimationFrame(paint);
  }
  function paint(): void {
    frame = null;
    const state = options.slide();
    const p = measure();
    if (!state || !p) return;
    if (remote) {
      if (remote.slideId !== state.slide.id) { ink.clear(); laser.hidden = true; return; }
      ink.append(remotePoints.slice(remotePainted));
      remotePainted = remotePoints.length;
      laser.hidden = !remote.laser;
      if (remote.laser) {
        laser.style.left = `${p.left - p.hostLeft + remote.laser.x * p.width / p.w}px`;
        laser.style.top = `${p.top - p.hostTop + remote.laser.y * p.height / p.h}px`;
      }
    } else if (active?.kind === 'ink') {
      if (state.slide.id !== active.slideId) { cancel(); return; }
      ink.append(active.points.slice(painted));
      painted = active.points.length;
      if (options.onOverlay && sent < painted) {
        options.onOverlay({ slideId: active.slideId, points: active.points.slice(sent),
          stroke: { id: active.stream, offset: sent }, laser: null, pen: active.pen });
        sent = painted;
      }
    } else if (laserPoint) {
      laser.style.left = `${laserPoint.x - p.hostLeft}px`;
      laser.style.top = `${laserPoint.y - p.hostTop}px`;
      laser.hidden = false;
      options.onOverlay?.({ slideId: state.slide.id, points: [], pen,
        laser: { x: (laserPoint.x - p.left) * p.w / p.width, y: (laserPoint.y - p.top) * p.h / p.height } });
    }
  }
  const pointLaser = (point: XY): void => { laserPoint = point; schedule(); };
  const down = (event: PointerEvent): void => {
    if (isToolEvent(event) || event.button !== 0) return;
    if (active) { consume(event); return; }
    suppressNextClick = false;
    if (remote) {
      remote = null; remotePoints = []; remoteStream = null; remotePainted = 0;
      painted = sent = 0; projection = null; ink.clear();
    }
    if (mode === 'laser' || event.ctrlKey) { consume(event); move(event); return; }
    if (mode === 'navigate' && (slideLinkFromEvent(event) || eventOnInteractiveWeb(event)
        || (event.target instanceof Element && event.target.closest('button, input, textarea, select, [contenteditable="true"]')))) return;
    const state = options.slide();
    const point = position(event);
    if (!state || !point) return;
    // Some Linux digitizers expose their stylus as touch. Explicit Pen mode
    // accepts either; Navigate still leaves ordinary touch gestures alone.
    const drawing = event.pointerType === 'pen' || mode === 'pen';
    if (drawing || mode === 'pen') {
      consume(event);
      if (document.activeElement instanceof HTMLElement && toolbar.contains(document.activeElement)) document.activeElement.blur();
    }
    const draft: PointerGesture = {
      id: event.pointerId, slideId: state.slide.id, points: [point], kind: drawing ? 'ink' : 'waiting',
      origin: { x: event.clientX, y: event.clientY }, timer: null,
      pen: { ...pen }, stream: makeId('ink-live'),
    };
    active = draft;
    laserPoint = null; laser.hidden = true;
    path.setAttribute('stroke', draft.pen.color);
    path.setAttribute('stroke-width', String(draft.pen.width));
    if (drawing) host.setPointerCapture(event.pointerId);
    draft.timer = setTimeout(() => {
      if (active !== draft) return;
      draft.timer = null;
      if (options.slide()?.slide.id !== draft.slideId) { cancel(); return; }
      draft.kind = 'laser';
      draft.points = [];
      ink.clear();
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
      const samples = [...event.getCoalescedEvents?.() ?? []];
      const last = samples.at(-1);
      if (!last || last.clientX !== event.clientX || last.clientY !== event.clientY) samples.push(event);
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
      schedule();
    } else if (!isToolEvent(event) && (mode === 'laser' || event.ctrlKey)) {
      consume(event);
      pointLaser({ x: event.clientX, y: event.clientY });
    } else { laserPoint = null; laser.hidden = true; }
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
    laserPoint = null; laser.hidden = true;
    projection = null;
    if (!active || active.kind !== 'ink') emitOverlay();
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
  window.addEventListener('resize', blur);
  return {
    reset: cancel,
    setToolbarVisible(visible) { toolbar.hidden = !visible; },
    showOverlay(overlay) {
      const state = options.slide();
      if (!state || state.slide.id !== overlay.slideId) { cancel(); return; }
      if (!overlay.points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))) return;
      if (overlay.laser && (!Number.isFinite(overlay.laser.x) || !Number.isFinite(overlay.laser.y))) return;
      if (overlay.stroke) {
        if (overlay.stroke.offset === 0 && remoteStream !== overlay.stroke.id) {
          ink.clear(); remotePoints = []; remotePainted = 0; remoteStream = overlay.stroke.id;
        }
        if (remoteStream !== overlay.stroke.id || overlay.stroke.offset !== remotePoints.length) return;
        for (const point of overlay.points) remotePoints.push(point);
      } else {
        ink.clear(); remotePoints = [...overlay.points]; remotePainted = 0; remoteStream = null;
      }
      remote = overlay;
      path.setAttribute('stroke', /^#[0-9a-f]{6}$/i.test(overlay.pen?.color ?? '') ? overlay.pen!.color : '#e53935');
      path.setAttribute('stroke-width', String(overlay.pen && Number.isFinite(overlay.pen.width) ? Math.max(1, Math.min(20, overlay.pen.width)) : 4));
      if (!remotePoints.length && !overlay.laser) {
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null; laser.hidden = true; path.setAttribute('d', '');
      } else {
        // The sender already batches ink once per animation frame. Waiting
        // for another frame here adds a full refresh interval on the projector.
        if (frame !== null) cancelAnimationFrame(frame);
        paint();
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
    window.removeEventListener('resize', blur);
    host.classList.remove('annotation-enabled');
    layer.remove(); toolbar.remove();
  } };
}
