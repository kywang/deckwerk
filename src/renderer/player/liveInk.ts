import type { XY } from '@shared/pathNodes.js';

/** Incremental, bounded SVG paths: adding ink never reparses the whole stroke. */
export class LiveInk {
  private current: SVGPathElement;
  private data = '';
  private last: XY | null = null;
  private end: XY | null = null;
  private count = 0;
  constructor(private readonly first: SVGPathElement) { this.current = first; }

  clear(): void {
    for (const sibling of [...this.first.parentElement?.children ?? []]) {
      if (sibling !== this.first) sibling.remove();
    }
    this.current = this.first;
    this.data = '';
    this.last = this.end = null;
    this.count = 0;
    this.first.removeAttribute('d');
  }

  append(points: readonly XY[]): void {
    for (const point of points) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
      if (this.last?.x === point.x && this.last.y === point.y) continue;
      if (!this.last) {
        this.data = `M ${point.x} ${point.y}`;
        this.last = this.end = point;
        continue;
      }
      if (this.count >= 128) {
        this.current.setAttribute('d', this.data);
        this.current = this.first.cloneNode(false) as SVGPathElement;
        this.first.parentElement?.append(this.current);
        this.data = `M ${this.end!.x} ${this.end!.y}`;
        this.count = 0;
      }
      this.end = { x: (this.last.x + point.x) / 2, y: (this.last.y + point.y) / 2 };
      this.data += ` Q ${this.last.x} ${this.last.y} ${this.end.x} ${this.end.y}`;
      this.last = point;
      this.count++;
    }
    if (this.last) this.current.setAttribute('d', `${this.data} L ${this.last.x} ${this.last.y}`);
  }
}
