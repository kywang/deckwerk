import { describe, expect, it } from 'vitest';
import {
  chooseAudienceDisplay,
  distinctPresentationDisplays,
  chooseDisplayById,
  shouldOpenSpeakerView,
  shouldShowAudienceWindow,
  swappedPresentationDisplays,
} from '../src/main/presentationDisplays.js';

describe('presenter display placement', () => {
  it('treats cloned outputs as one presentation surface even with different resolutions', () => {
    const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 } };
    const mirror = { id: 2, bounds: { x: 0, y: 0, width: 2560, height: 1440 } };
    const extended = { id: 3, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } };
    expect(distinctPresentationDisplays([mirror, laptop], laptop)).toEqual([laptop]);
    expect(distinctPresentationDisplays([mirror, laptop, extended], laptop)).toEqual([laptop, extended]);
    expect(shouldOpenSpeakerView(chooseAudienceDisplay(distinctPresentationDisplays([mirror, laptop], laptop), laptop), laptop)).toBe(false);
  });

  it('uses an external display for the audience', () => {
    const laptop = { id: 1, name: 'laptop' };
    const projector = { id: 2, name: 'projector' };
    expect(chooseAudienceDisplay([laptop, projector], laptop)).toBe(projector);
  });

  it('falls back to the laptop when it is the only display', () => {
    const laptop = { id: 1 };
    expect(chooseAudienceDisplay([laptop], laptop)).toBe(laptop);
  });

  it('uses a requested mapping only while that display is connected', () => {
    const laptop = { id: 1 };
    const projector = { id: 2 };
    expect(chooseDisplayById([laptop, projector], 2, laptop)).toBe(projector);
    expect(chooseDisplayById([laptop], 2, laptop)).toBe(laptop);
  });

  it('opens Speaker View automatically only when the audience has another display', () => {
    const laptop = { id: 1 };
    const projector = { id: 2 };
    expect(shouldOpenSpeakerView(projector, laptop)).toBe(true);
    expect(shouldOpenSpeakerView(laptop, laptop)).toBe(false);
    expect(shouldOpenSpeakerView(laptop, laptop, true)).toBe(true);
  });

  it('keeps the audience window hidden when forced Speaker View owns the same display', () => {
    const laptop = { id: 1 };
    const projector = { id: 2 };

    expect(shouldShowAudienceWindow(laptop, laptop, true)).toBe(false);
    expect(shouldShowAudienceWindow(projector, laptop, true)).toBe(true);
    expect(shouldShowAudienceWindow(laptop, laptop, false)).toBe(true);
  });

  it('switches the audience and presenter roles while both displays remain connected', () => {
    const laptop = { id: 1, name: 'laptop' };
    const projector = { id: 2, name: 'projector' };
    expect(swappedPresentationDisplays(
      [laptop, projector],
      { audienceDisplayId: projector.id, presenterDisplayId: laptop.id },
      laptop,
    )).toEqual({ audience: laptop, presenter: projector });
    expect(swappedPresentationDisplays(
      [laptop],
      { audienceDisplayId: projector.id, presenterDisplayId: laptop.id },
      laptop,
    )).toBeNull();
  });
});
