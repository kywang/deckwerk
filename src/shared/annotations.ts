import type { ShapeEl, Slide } from './deck.js';
import { makeId } from './geometry.js';
import { freehandRun, pathGeometry, pathOnCanvas, nearestOnPath, type XY } from './pathNodes.js';

/** Annotations are ordinary vector shapes: editable, undoable and printable. */
export function annotationStroke(slide: Slide, points: XY[], color = '#e53935', width = 4): ShapeEl | null {
  const run = freehandRun(points, 1);
  if (!run) return null;
  return {
    id: makeId('ink'), type: 'shape', shape: 'path', ...pathGeometry([run]),
    rot: 0, z: Math.max(0, ...slide.elements.map((element) => element.z)) + 1,
    opacity: 1, class: [], style: {}, fill: null, stroke: color, strokeWidth: width,
    radius: 0, arrowStart: false, arrowEnd: false,
  };
}

/** Only unfilled vector strokes can be erased; text, images and filled shapes stay intact. */
export function erasableStroke(el: Slide['elements'][number]): el is ShapeEl {
  return el.type === 'shape' && el.shape === 'path' && !el.fill && !!el.stroke;
}
export function erasedStrokeIds(slide: Slide, samples: XY[], radius = 12): string[] {
  return slide.elements.filter(erasableStroke).filter((el) => {
    const paths = pathOnCanvas(el);
    if (!paths) return false;
    return samples.some((point, i) => {
      const previous = samples[Math.max(0, i - 1)];
      const steps = Math.max(1, Math.ceil(Math.hypot(point.x - previous.x, point.y - previous.y) / Math.max(1, radius)));
      for (let step = 0; step <= steps; step++) {
        const hit = nearestOnPath(paths, { x: previous.x + (point.x - previous.x) * step / steps, y: previous.y + (point.y - previous.y) * step / steps });
        if (hit && hit.distance <= radius + el.strokeWidth / 2) return true;
      }
      return false;
    });
  }).map((el) => el.id);
}
export function withoutInk(slide: Slide, ids: string[]): Slide {
  const removed = new Set(ids);
  return { ...slide, elements: slide.elements.filter((el) => !removed.has(el.id) || !erasableStroke(el)) };
}
