// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDeck, parseDeck, type ShapeEl } from '../src/shared/deck.js';
import { annotationStroke } from '../src/shared/annotations.js';
import { pathOnCanvas } from '../src/shared/pathNodes.js';
import { createAnnotationTools } from '../src/renderer/player/annotationTools.js';
import { buildPrintPages } from '../src/renderer/print/pages.js';
import { installCanvasDomShims } from './support/canvasHarness.js';

let destroy: (() => void) | undefined;
afterEach(() => { destroy?.(); destroy = undefined; document.body.replaceChildren(); });

function setup() {
  installCanvasDomShims();
  const deck = emptyDeck('Annotated talk');
  const host = document.createElement('div');
  host.innerHTML = '<div class="stage"></div>';
  document.body.append(host);
  host.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 600 }) as DOMRect;
  host.firstElementChild!.getBoundingClientRect = () => ({ left: 20, top: 30, width: 960, height: 540 }) as DOMRect;
  let current = 0;
  const save = vi.fn((slideId: string, stroke: ShapeEl) => deck.slides.find((s) => s.id === slideId)!.elements.push(stroke));
  const tools = createAnnotationTools({ host, slide: () => ({ slide: deck.slides[current], canvas: deck.canvas }), save });
  destroy = tools.destroy;
  const pointer = (type: string, x: number, y: number, id = 1, pointerType = 'mouse', ctrlKey = false) => {
    const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: id, button: 0, ctrlKey });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    host.dispatchEvent(event);
    return event;
  };
  const choose = (mode: string) => host.querySelector<HTMLButtonElement>(`[data-annotation-mode="${mode}"]`)!.click();
  return { deck, host, save, pointer, choose, next: () => { current++; } };
}

describe('presentation annotation tools', () => {
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
