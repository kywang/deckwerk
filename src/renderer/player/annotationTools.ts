import type { ShapeEl, Slide } from '@shared/deck.js';
import { annotationStroke } from '@shared/annotations.js';
import type { XY } from '@shared/pathNodes.js';
import { button } from '../editor/ui.js';
import { eventOnInteractiveWeb, slideLinkFromEvent } from './links.js';
import './annotationTools.css';

type Mode = 'navigate' | 'pen' | 'laser';
export const LASER_HOLD_MS = 500;
const HOLD_SLOP_PX = 8;
interface PointerGesture {
  id: number; slideId: string; points: XY[]; kind: 'ink' | 'waiting' | 'laser';
  origin: XY; timer: ReturnType<typeof setTimeout> | null;
}
export interface AnnotationToolsOptions {
  host: HTMLElement;
  slide(): { slide: Slide; canvas: { w: number; h: number } } | null;
  /** Commit through the editor/collaboration store, never overwrite the deck. */
  save(slideId: string, stroke: ShapeEl): void;
}

/** Presentation-only chrome; ink itself uses the normal slide renderer. */
export function createAnnotationTools(options: AnnotationToolsOptions): { destroy(): void } {
  const { host } = options;
  let mode: Mode = 'navigate';
  let active: PointerGesture | null = null;
  let suppressNextClick = false;
  const layer = document.createElement('div');
  layer.className = 'annotation-layer';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('annotation-preview');
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', '#e53935');
  path.setAttribute('stroke-width', '4');
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
  const cancel = (): void => {
    const id = active?.id;
    if (active?.timer !== null && active?.timer !== undefined) clearTimeout(active.timer);
    active = null;
    path.removeAttribute('d');
    layer.classList.toggle('annotation-active', mode !== 'navigate');
    layer.classList.toggle('laser-active', mode === 'laser');
    laser.hidden = true;
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
  host.append(layer, toolbar);
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
  const pointLaser = (point: XY): void => {
    const rect = host.getBoundingClientRect();
    laser.style.left = `${point.x - rect.left}px`;
    laser.style.top = `${point.y - rect.top}px`;
    laser.hidden = false;
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
    if (drawing || mode === 'pen') consume(event);
    const draft: PointerGesture = {
      id: event.pointerId, slideId: state.slide.id, points: [point], kind: drawing ? 'ink' : 'waiting',
      origin: { x: event.clientX, y: event.clientY }, timer: null,
    };
    active = draft;
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
    const stroke = annotationStroke(state.slide, draft.points);
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
  return { destroy() {
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
