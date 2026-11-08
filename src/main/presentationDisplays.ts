/** X11 can report cloned outputs as separate IDs at the same desktop origin.
 * One audience window is mirrored by the OS; a second Speaker View covers it.
 * Keep the primary representative so remembered IDs fall back consistently.
 */
export function distinctPresentationDisplays<T extends { id: number; bounds: { x: number; y: number } }>(
  displays: T[], primary: T,
): T[] {
  const seen = new Set<string>();
  return [primary, ...displays.filter((display) => display.id !== primary.id)].filter((display) => {
    const key = `${display.bounds.x},${display.bounds.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Pick a projector when available, otherwise present on the laptop display. */
export function chooseAudienceDisplay<T extends { id: number }>(
  displays: T[],
  primary: T,
): T {
  return displays.find((display) => display.id !== primary.id) ?? primary;
}

/** Use a remembered/user-selected display when it is still connected. */
export function chooseDisplayById<T extends { id: number }>(
  displays: T[],
  requestedId: number | undefined,
  fallback: T,
): T {
  return displays.find((display) => display.id === requestedId) ?? fallback;
}

/**
 * Speaker View is automatic when the audience has its own display. The
 * explicit menu action can still force it for a one-display rehearsal.
 */
export function shouldOpenSpeakerView(
  audience: { id: number },
  presenter: { id: number },
  forced = false,
): boolean {
  return forced || audience.id !== presenter.id;
}

/**
 * A forced one-display Speaker View owns that display. Its audience player
 * still runs as the presentation state source, but must never flash on screen
 * before the speaker controls are ready.
 */
export function shouldShowAudienceWindow(
  audience: { id: number },
  presenter: { id: number },
  openSpeakerView: boolean,
): boolean {
  return !openSpeakerView || audience.id !== presenter.id;
}

/** Resolve the inverse of the active audience/presenter mapping. */
export function swappedPresentationDisplays<T extends { id: number }>(
  displays: T[],
  active: { audienceDisplayId: number; presenterDisplayId: number },
  fallback: T,
): { audience: T; presenter: T } | null {
  const audience = chooseDisplayById(displays, active.presenterDisplayId, fallback);
  const presenter = chooseDisplayById(displays, active.audienceDisplayId, fallback);
  return audience.id === presenter.id ? null : { audience, presenter };
}
