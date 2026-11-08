import type { ShapeEl, Slide } from './deck.js';
import { makeId } from './geometry.js';
import { freehandRun, pathGeometry, type XY } from './pathNodes.js';

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
