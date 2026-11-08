// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type ShapeEl } from '../src/shared/deck.js';
import { annotationStroke } from '../src/shared/annotations.js';
import { pathOnCanvas } from '../src/shared/pathNodes.js';
import type { AnnotationOverlay } from '../src/shared/ipc.js';
import { createAnnotationTools, PEN_COLORS, PEN_WIDTHS } from '../src/renderer/player/annotationTools.js';
import { buildPrintPages } from '../src/renderer/print/pages.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

const originalFrame = window.requestAnimationFrame;
const originalCancelFrame = window.cancelAnimationFrame;
let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 1;
const requestFrame = (callback: FrameRequestCallback): number => { const id = nextFrame++; frames.set(id, callback); return id; };
const cancelFrame = (id: number): void => { frames.delete(id); };
function flushFrames(): void {
  for (let turn = 0; frames.size && turn < 10; turn++) {
    const pending = [...frames.values()]; frames.clear();
    for (const callback of pending) callback(performance.now());
  }
}
function advance(ms: number): void { vi.advanceTimersByTime(ms); flushFrames(); }
beforeEach(() => { localStorage.removeItem('deckwerk.annotation.pen'); frames = new Map(); nextFrame = 1; });
let destroy: (() => void) | undefined;
afterEach(() => { destroy?.(); destroy = undefined; vi.useRealTimers(); window.requestAnimationFrame = originalFrame; window.cancelAnimationFrame = originalCancelFrame; document.body.replaceChildren(); });

function setup(onOverlay?: (overlay: AnnotationOverlay) => void) {
  installCanvasDomShims();
  window.requestAnimationFrame = requestFrame; window.cancelAnimationFrame = cancelFrame;
  const deck = emptyDeck('Annotated talk');
  const host = document.createElement('div');
  host.innerHTML = '<div class="stage"></div>';
  document.body.append(host);
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect;
  host.firstElementChild!.getBoundingClientRect = () => ({ left: 20, top: 30, width: 960, height: 540 }) as DOMRect;
  let current = 0;
  const save = vi.fn((slideId: string, stroke: ShapeEl) => deck.slides.find((s) => s.id === slideId)!.elements.push(stroke));
  const tools = createAnnotationTools({ host, onOverlay, slide: () => ({ slide: deck.slides[current], canvas: deck.canvas }), save });
  destroy = tools.destroy;
  const pointer = (type: string, x: number, y: number, id = 1, pointerType = 'mouse', ctrlKey = false) => {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, button: 0, ctrlKey });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    host.dispatchEvent(event);
    flushFrames();
    return event;
  };
  const choose = (mode: string) => host.querySelector<HTMLButtonElement>(`[data-annotation-mode="${mode}"]`)!.click();
  return { deck, host, tools, save, pointer, choose, next: () => { current++; } };
}

describe('presentation annotation tools', () => {
  it('paints frame-batched presenter ink immediately without adding an audience frame of latency', () => {
    const { host, tools, deck } = setup();
    tools.showOverlay({ slideId: deck.slides[0].id, points: [{ x: 100, y: 100 }, { x: 200, y: 150 }], laser: null,
      stroke: { id: 'latency', offset: 0 } });
    expect(host.querySelector('.annotation-preview path')?.getAttribute('d')).toContain('L 200 150');
    expect(frames.size).toBe(0);
    tools.showOverlay({ slideId: deck.slides[0].id, points: [{ x: 300, y: 200 }], laser: null,
      stroke: { id: 'latency', offset: 2 } });
    expect(host.querySelector('.annotation-preview path')?.getAttribute('d')).toContain('L 300 200');
    expect(frames.size).toBe(0);
  });

  it('batches a coalesced burst without repeating layout reads or retransmitting old points', () => {
    const updates: AnnotationOverlay[] = [];
    const { host, pointer, save } = setup((overlay) => updates.push(overlay));
    const stage = host.querySelector('.stage')!;
    const reads = vi.spyOn(stage, 'getBoundingClientRect');
    pointer('pointerdown', 100, 100, 1, 'pen');
    updates.length = 0;
    for (let frame = 0; frame < 20; frame++) {
      for (let move = 0; move < 10; move++) {
        const x = 110 + frame * 100 + move * 10;
        const event = new PointerEvent('pointermove', { pointerId: 1, clientX: x, clientY: 200, bubbles: true });
        Object.defineProperty(event, 'getCoalescedEvents', { value: () => Array.from({ length: 10 }, (_, i) => ({ clientX: x - 9 + i, clientY: 200 })) });
        host.dispatchEvent(event);
      }
      flushFrames();
    }
    const strokes = updates.filter((update) => update.stroke);
    expect(strokes).toHaveLength(20);
    expect(strokes.reduce((total, update) => total + update.points.length, 0)).toBe(2001);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(host.querySelectorAll('.annotation-preview path').length).toBeGreaterThan(1);
    expect([...host.querySelectorAll('.annotation-preview path')].every((path) => (path.getAttribute('d')?.length ?? 0) < 20_000)).toBe(true);
    pointer('pointerup', 2100, 200, 1, 'pen');
    expect(save).toHaveBeenCalledTimes(1);
    expect(pathOnCanvas(save.mock.calls[0][1])![0].nodes.at(-1)?.x).toBe(1920);
    expect(frames.size).toBe(0);
    reads.mockRestore();
  });

  it('drops queued previews on cancel and ignores stale out-of-order stroke deltas', () => {
    const { host, tools, pointer, save } = setup();
    const stroke = { id: 'stream', offset: 0 };
    tools.showOverlay({ slideId: 'slide-1', points: [{ x: 10, y: 10 }], laser: null, stroke });
    tools.showOverlay({ slideId: 'slide-1', points: [], laser: null });
    tools.showOverlay({ slideId: 'slide-1', points: [{ x: 20, y: 20 }], laser: null, stroke: { id: 'stream', offset: 1 } });
    flushFrames();
    expect(host.querySelector('.annotation-preview path')?.getAttribute('d')).toBe('');
    pointer('pointerdown', 100, 100, 1, 'pen');
    host.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 200, clientY: 200, bubbles: true }));
    pointer('pointercancel', 200, 200, 1, 'pen');
    expect(frames.size).toBe(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('uses selected colour and width for the preview, saved stroke and PDF pages', () => {
    const { host, pointer, save, deck } = setup();
    const set = (label: string, value: string) => {
      const select = host.querySelector<HTMLSelectElement>(`[aria-label="Pen ${label}"]`)!;
      select.value = value; select.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('color', '#1976d2'); set('width', '12');
    pointer('pointerdown', 100, 100, 1, 'pen');
    pointer('pointermove', 300, 200, 1, 'pen');
    const preview = host.querySelector('.annotation-preview path')!;
    expect(preview.getAttribute('stroke')).toBe('#1976d2');
    expect(preview.getAttribute('stroke-width')).toBe('12');
    pointer('pointerup', 400, 200, 1, 'pen');
    expect(save.mock.calls[0][1]).toMatchObject({ stroke: '#1976d2', strokeWidth: 12 });
    const container = document.createElement('div');
    buildPrintPages(container, { deck: parseDeck(JSON.parse(JSON.stringify(deck))), mode: 'final', resolveSrc: (src) => src });
    expect(container.querySelector('svg path[stroke="#1976d2"]')?.getAttribute('stroke')).toBe('#1976d2');
    expect(container.querySelector('svg path[stroke="#1976d2"]')?.getAttribute('stroke-width')).toBe('12');
  });

  it('mirrors selected pen settings and remembers them when a presentation is reopened', () => {
    const audience = setup();
    const presenter = setup((overlay) => audience.tools.showOverlay(overlay));
    const color = presenter.host.querySelector<HTMLSelectElement>('[aria-label="Pen color"]')!;
    const width = presenter.host.querySelector<HTMLSelectElement>('[aria-label="Pen width"]')!;
    color.value = '#8e24aa'; color.dispatchEvent(new Event('change'));
    width.value = '20'; width.dispatchEvent(new Event('change'));
    presenter.pointer('pointerdown', 100, 100, 1, 'pen');
    presenter.pointer('pointermove', 300, 200, 1, 'pen');
    expect(audience.host.querySelector('.annotation-preview path')?.getAttribute('stroke')).toBe('#8e24aa');
    expect(audience.host.querySelector('.annotation-preview path')?.getAttribute('stroke-width')).toBe('20');
    presenter.tools.destroy(); audience.tools.destroy(); destroy = undefined;
    const reopened = setup();
    expect(reopened.host.querySelector<HTMLSelectElement>('[aria-label="Pen color"]')!.value).toBe('#8e24aa');
    expect(reopened.host.querySelector<HTMLSelectElement>('[aria-label="Pen width"]')!.value).toBe('20');
    const navigate = vi.fn();
    window.addEventListener('keydown', navigate);
    reopened.host.querySelector('select')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(navigate).not.toHaveBeenCalled();
    window.removeEventListener('keydown', navigate);
  });

  it('uses safe defaults for broken stored settings and still draws when storage is unavailable', () => {
    localStorage.setItem('deckwerk.annotation.pen', JSON.stringify({ color: 'invalid', width: -5 }));
    const { host, pointer, save } = setup();
    expect(host.querySelector<HTMLSelectElement>('[aria-label="Pen width"]')!.value).toBe('4');
    const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const width = host.querySelector<HTMLSelectElement>('[aria-label="Pen width"]')!;
    width.value = '8'; width.dispatchEvent(new Event('change'));
    pointer('pointerdown', 100, 100, 1, 'pen');
    pointer('pointermove', 300, 200, 1, 'pen');
    pointer('pointerup', 400, 200, 1, 'pen');
    expect(save.mock.calls[0][1]).toMatchObject({ stroke: '#e53935', strokeWidth: 8 });
    storage.mockRestore();
  });

  it('relays presenter ink and laser to a scaled audience overlay with hidden controls', () => {
    const audience = setup();
    audience.tools.setToolbarVisible(false);
    const presenter = setup((overlay) => audience.tools.showOverlay(overlay));
    presenter.choose('laser');
    presenter.pointer('pointermove', 500, 300);
    const laser = audience.host.querySelector<HTMLElement>('.presentation-laser')!;
    expect(laser.hidden).toBe(false);
    expect(laser.style.left).toBe('500px');
    expect(laser.style.top).toBe('300px');
    expect(audience.host.querySelector<HTMLElement>('.annotation-toolbar')!.hidden).toBe(true);
    presenter.choose('pen');
    expect(laser.hidden).toBe(true);
    presenter.pointer('pointerdown', 100, 100);
    presenter.pointer('pointermove', 300, 200);
    expect(audience.host.querySelector('.annotation-preview path')?.getAttribute('d')).toContain('L 560 340');
    presenter.pointer('pointerup', 400, 250);
    expect(presenter.save).toHaveBeenCalledTimes(1);
    expect(audience.save).not.toHaveBeenCalled();
    expect(audience.host.querySelector('.annotation-preview path')?.getAttribute('d')).toBe('');
    audience.tools.showOverlay({ slideId: 'other-slide', laser: { x: 100, y: 100 }, points: [] });
    expect(laser.hidden).toBe(true);
    audience.tools.destroy();
  });

  it.each(['pen', 'mouse', 'touch'])('holds %s for a temporary laser and restores Pen on release', (pointerType) => {
    vi.useFakeTimers();
    const { host, save, pointer, choose } = setup();
    choose('pen');
    const laser = host.querySelector<HTMLElement>('.presentation-laser')!;
    pointer('pointerdown', 150, 200, 1, pointerType);
    advance(499);
    expect(laser.hidden).toBe(true);
    advance(1);
    expect(laser.hidden).toBe(false);
    pointer('pointermove', 400, 300, 1, pointerType);
    expect(laser.style.left).toBe('400px');
    pointer('pointerup', 400, 300, 1, pointerType);
    pointer('click', 400, 300, 1, pointerType);
    expect(laser.hidden).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(host.querySelector('[data-annotation-mode="pen"]')?.getAttribute('aria-pressed')).toBe('true');
    pointer('pointerdown', 100, 100, 1, pointerType);
    pointer('pointermove', 300, 200, 1, pointerType);
    pointer('pointerup', 400, 200, 1, pointerType);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('preserves short Navigate taps and suppresses navigation after a long touch', () => {
    vi.useFakeTimers();
    const { host, pointer, save } = setup();
    const navigate = vi.fn();
    host.addEventListener('click', navigate);
    const fullscreen = vi.fn();
    host.addEventListener('dblclick', fullscreen);
    pointer('pointerdown', 100, 100, 1, 'touch');
    advance(200);
    pointer('pointerup', 100, 100, 1, 'touch');
    pointer('click', 100, 100, 1, 'touch');
    expect(navigate).toHaveBeenCalledTimes(1);
    pointer('pointerdown', 100, 100, 1, 'touch');
    advance(500);
    expect(host.querySelector<HTMLElement>('.presentation-laser')!.hidden).toBe(false);
    pointer('pointerup', 300, 200, 1, 'touch');
    pointer('click', 300, 200, 1, 'touch');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(save).not.toHaveBeenCalled();
    pointer('dblclick', 300, 200, 1, 'touch');
    expect(fullscreen).not.toHaveBeenCalled();
    // The next independent tap still navigates.
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 100, 100);
    pointer('click', 100, 100);
    expect(navigate).toHaveBeenCalledTimes(2);
  });

  it('tolerates hand jitter but never turns a paused drawing into a laser', () => {
    vi.useFakeTimers();
    const { host, pointer, save } = setup();
    const laser = host.querySelector<HTMLElement>('.presentation-laser')!;
    pointer('pointerdown', 100, 100, 1, 'pen');
    pointer('pointermove', 103, 104, 1, 'pen');
    advance(500);
    expect(laser.hidden).toBe(false);
    pointer('pointerup', 103, 104, 1, 'pen');
    pointer('pointerdown', 100, 100, 1, 'pen');
    pointer('pointermove', 130, 120, 1, 'pen');
    advance(1000);
    expect(laser.hidden).toBe(true);
    pointer('pointerup', 200, 150, 1, 'pen');
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending hold on release, capture loss, blur, tool change or slide change', () => {
    vi.useFakeTimers();
    for (const reason of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur', 'tool', 'slide', 'destroy']) {
      const { host, pointer, choose, deck, next, save } = setup();
      pointer('pointerdown', 100, 100, 1, 'pen');
      advance(200);
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else if (reason === 'tool') choose('navigate');
      else if (reason === 'slide') { deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'other' }); next(); }
      else if (reason === 'destroy') destroy!();
      else pointer(reason, 100, 100, 1, 'pen');
      advance(1000);
      expect(host.querySelector<HTMLElement>('.presentation-laser')?.hidden ?? true).toBe(true);
      expect(save).not.toHaveBeenCalled();
      destroy!(); destroy = undefined;
      host.remove();
    }
  });

  it('fuzzes hold, draw and cancel gestures without saving laser movements', () => {
    vi.useFakeTimers();
    const audience = setup();
    audience.tools.setToolbarVisible(false);
    const { host, pointer, save, choose } = setup((overlay) => audience.tools.showOverlay(overlay));
    let seed = 8317;
    let expectedInk = 0;
    for (let step = 0; step < 60; step++) {
      seed = (seed * 16807) % 2147483647;
      const action = seed % 4;
      choose('pen');
      const color = host.querySelector<HTMLSelectElement>('[aria-label="Pen color"]')!;
      color.value = PEN_COLORS[seed % PEN_COLORS.length][1]; color.dispatchEvent(new Event('change'));
      const width = host.querySelector<HTMLSelectElement>('[aria-label="Pen width"]')!;
      width.value = String(PEN_WIDTHS[seed % PEN_WIDTHS.length]); width.dispatchEvent(new Event('change'));
      const device = step % 2 ? 'touch' : 'pen';
      pointer('pointerdown', 100, 100, 1, device);
      if (action === 0) {
        advance(500);
        pointer('pointermove', 500, 300, 1, device);
      } else if (action === 1) {
        pointer('pointermove', 200, 150, 1, device);
        advance(800);
        expectedInk++;
      } else if (action === 2) pointer('pointercancel', 100, 100, 1, device);
      else window.dispatchEvent(new Event('blur'));
      pointer('pointerup', 500, 300, 1, device);
      pointer('click', 500, 300, 1, device);
      advance(600);
      expect(save).toHaveBeenCalledTimes(expectedInk);
      if (action === 1) expect(save.mock.calls.at(-1)![1]).toMatchObject({ stroke: color.value, strokeWidth: Number(width.value) });
      expect(host.querySelector<HTMLElement>('.presentation-laser')!.hidden).toBe(true);
      expect(audience.host.querySelector<HTMLElement>('.presentation-laser')!.hidden).toBe(true);
      expect(audience.save).not.toHaveBeenCalled();
    }
    audience.tools.destroy();
  });

  it('draws a stylus stroke without advancing, in slide coordinates, then persists and prints it', () => {
    const { deck, host, save, pointer } = setup();
    const navigate = vi.fn();
    host.addEventListener('click', navigate);
    pointer('pointerdown', 120, 130, 1, 'pen');
    pointer('pointermove', 220, 180, 1, 'pen');
    expect(host.querySelector('.annotation-preview path')?.getAttribute('d')).toContain('L 400 300');
    pointer('pointerup', 320, 230, 1, 'pen');
    pointer('click', 320, 230, 1, 'pen');
    expect(save).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    const restored = parseDeck(JSON.parse(JSON.stringify(deck)));
    const stroke = restored.slides[0].elements[0] as ShapeEl;
    expect(stroke).toMatchObject({ shape: 'path', stroke: '#e53935', strokeWidth: 4, fill: null });
    expect(pathOnCanvas(stroke)![0].nodes.at(-1)).toMatchObject({ x: 600, y: 400 });
    for (const mode of ['initial', 'final', 'every'] as const) {
      const container = document.createElement('div');
      const pages = buildPrintPages(container, { deck: restored, mode, resolveSrc: (src) => src });
      expect(pages).toHaveLength(1);
      expect(container.querySelector(`[data-element-id="${stroke.id}"] svg path`)).not.toBeNull();
      expect(container.querySelector('.annotation-toolbar, .presentation-laser')).toBeNull();
    }
  });

  it('uses Pen for mouse drawing, suppresses tool clicks and permits normal navigation', () => {
    const { host, save, choose, pointer } = setup();
    const navigate = vi.fn();
    host.addEventListener('click', navigate);
    choose('pen');
    pointer('pointerdown', 100, 100);
    pointer('pointermove', 200, 200);
    pointer('pointerup', 300, 250);
    pointer('click', 300, 250);
    expect(save).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    choose('navigate');
    pointer('click', 300, 250);
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('ignores palm contacts and discards cancellation and capture loss', () => {
    const { save, pointer } = setup();
    pointer('pointerdown', 100, 100, 1, 'pen');
    pointer('pointerdown', 800, 500, 2, 'touch');
    pointer('pointerup', 800, 500, 2, 'touch');
    expect(save).not.toHaveBeenCalled();
    pointer('pointermove', 200, 150, 1, 'pen');
    pointer('pointerup', 300, 200, 1, 'pen');
    expect(save).toHaveBeenCalledTimes(1);
    for (const reason of ['pointercancel', 'lostpointercapture']) {
      pointer('pointerdown', 100, 100, 1, 'pen');
      pointer('pointermove', 200, 150, 1, 'pen');
      pointer(reason, 200, 150);
      pointer('pointerup', 300, 200, 1, 'pen');
    }
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('never attaches an unfinished stroke to the next slide', () => {
    const { deck, save, pointer, next } = setup();
    deck.slides.push({ ...structuredClone(deck.slides[0]), id: 'second' });
    pointer('pointerdown', 100, 100, 1, 'pen');
    pointer('pointermove', 200, 150, 1, 'pen');
    next();
    pointer('pointerup', 300, 200, 1, 'pen');
    expect(save).not.toHaveBeenCalled();
  });

  it('shows a temporary laser, consumes pointer clicks and leaves no saved ink', () => {
    const { host, deck, save, choose, pointer } = setup();
    const navigate = vi.fn();
    host.addEventListener('click', navigate);
    choose('laser');
    pointer('pointermove', 150, 200);
    const laser = host.querySelector<HTMLElement>('.presentation-laser')!;
    expect(laser.hidden).toBe(false);
    expect(laser.style.left).toBe('150px');
    pointer('pointerdown', 150, 200);
    pointer('pointerup', 150, 200);
    pointer('click', 150, 200);
    expect(navigate).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    expect(laser.hidden).toBe(true);
    expect(host.querySelector('[data-annotation-mode="navigate"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(save).not.toHaveBeenCalled();
    expect(deck.slides[0].elements).toHaveLength(0);
  });

  it('cleans up listeners and never steals shortcuts from text fields', () => {
    const { host } = setup();
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', bubbles: true }));
    expect(host.querySelector('[data-annotation-mode="pen"]')?.getAttribute('aria-pressed')).toBe('false');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l' }));
    expect(host.querySelector('[data-annotation-mode="laser"]')?.getAttribute('aria-pressed')).toBe('true');
    destroy!(); destroy = undefined;
    expect(host.querySelector('.annotation-toolbar')).toBeNull();
    const event = new KeyboardEvent('keydown', { key: 'l', cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it('supports holding Ctrl as a temporary laser and hides it on release', () => {
    const { host, save, pointer } = setup();
    const navigate = vi.fn();
    host.addEventListener('click', navigate);
    pointer('pointermove', 150, 200, 1, 'mouse', true);
    const laser = host.querySelector<HTMLElement>('.presentation-laser')!;
    expect(laser.hidden).toBe(false);
    pointer('click', 150, 200, 1, 'mouse', true);
    expect(navigate).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }));
    expect(laser.hidden).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });
});

it('does not create paths for a tap or identical samples', () => {
  const slide = emptyDeck().slides[0];
  expect(annotationStroke(slide, [{ x: 10, y: 10 }])).toBeNull();
  expect(annotationStroke(slide, [{ x: 10, y: 10 }, { x: 10, y: 10 }])).toBeNull();
});
