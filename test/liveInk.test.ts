// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { LiveInk } from '../src/renderer/player/liveInk.js';

function setup() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const path = document.createElementNS(svg.namespaceURI, 'path') as SVGPathElement;
  path.setAttribute('stroke', '#1976d2'); path.setAttribute('stroke-width', '12');
  svg.append(path);
  return { svg, path, ink: new LiveInk(path) };
}

describe('incremental live ink', () => {
  it('bounds preview precision to avoid parsing long coordinate strings on every frame', () => {
    const { path, ink } = setup();
    const points = Array.from({ length: 100 }, (_, i) => ({ x: i * 1920 / 771, y: i * 1080 / 653 }));
    ink.append(points);
    const data = path.getAttribute('d')!;
    expect(data.length).toBeLessThan(4000);
    for (const number of data.match(/-?\d+(?:\.\d+)?/g)!) {
      expect(number.split('.')[1]?.length ?? 0).toBeLessThanOrEqual(2);
    }
  });

  it('keeps long strokes in bounded paths and never rewrites completed segments', () => {
    const { svg, path, ink } = setup();
    const points = Array.from({ length: 10_000 }, (_, i) => ({ x: i / 10, y: 300 + Math.sin(i / 20) * 100 }));
    ink.append(points.slice(0, 512));
    const firstSegment = path.getAttribute('d');
    for (let start = 512; start < points.length; start += 64) ink.append(points.slice(start, start + 64));
    expect(path.getAttribute('d')).toBe(firstSegment);
    expect(svg.children.length).toBeGreaterThan(1);
    expect(svg.children.length).toBeLessThanOrEqual(80);
    for (const child of svg.children) {
      expect(child.getAttribute('d')!.length).toBeLessThan(20_000);
      expect(child.getAttribute('stroke')).toBe('#1976d2');
      expect(child.getAttribute('stroke-width')).toBe('12');
    }
    const tail = svg.lastElementChild!.getAttribute('d')!.match(/L ([\d.]+) ([\d.]+)$/)!;
    expect(Math.abs(Number(tail[1]) - points.at(-1)!.x)).toBeLessThanOrEqual(0.005);
    expect(Math.abs(Number(tail[2]) - points.at(-1)!.y)).toBeLessThanOrEqual(0.005);
  });

  it('smooths the live line, tolerates duplicate or invalid samples and resets completely', () => {
    const { svg, path, ink } = setup();
    ink.append([{ x: 0, y: 0 }, { x: 10, y: 20 }, { x: 10, y: 20 }, { x: NaN, y: 1 }, { x: 20, y: 0 }]);
    expect(path.getAttribute('d')).toContain('Q 10 20 15 10');
    expect(path.getAttribute('d')).toContain('L 20 0');
    expect(path.getAttribute('d')).not.toContain('NaN');
    ink.clear();
    expect(svg.children).toHaveLength(1);
    expect(path.getAttribute('d')).toBeNull();
    ink.append([{ x: 100, y: 100 }, { x: 200, y: 200 }]);
    expect(path.getAttribute('d')).toMatch(/^M 100 100/);
  });
});
