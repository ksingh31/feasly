/**
 * Roving tabindex for card radio groups (#937, WAI-ARIA APG radio group).
 *
 * One Tab stop per group: the checked radio gets `tabindex="0"`, the others
 * `-1`; with nothing checked, the first radio is the Tab stop. Arrow keys move
 * focus AND selection within the group (wrapping); Home/End jump to the first
 * and last. Click/Space/Enter stay native on the buttons.
 */

/** Tab index for the radio `id` in a group whose checked value is `selected`. */
export function radioTabIndex<TId>(ids: readonly TId[], selected: TId | null | undefined, id: TId): 0 | -1 {
  const stop = selected != null && ids.includes(selected) ? selected : ids[0];
  return id === stop ? 0 : -1;
}

/**
 * Radio-group keydown handler. Call from the `role="radiogroup"` element's
 * `(keydown)`. Returns true when the key was handled.
 */
export function handleRadioGroupKeydown<TId>(
  event: KeyboardEvent,
  ids: readonly TId[],
  selected: TId | null | undefined,
  choose: (id: TId) => void,
): boolean {
  if (ids.length === 0) {
    return false;
  }
  const radios = radiosOf(event.currentTarget);
  // Move from the focused radio when there is one, else from the checked value.
  const focused = radios.findIndex((r) => r === event.target);
  const current = focused >= 0 ? focused : ids.indexOf(selected as TId);
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = current < 0 ? 0 : (current + 1) % ids.length;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = current < 0 ? ids.length - 1 : (current - 1 + ids.length) % ids.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = ids.length - 1;
      break;
    default:
      return false;
  }
  event.preventDefault();
  choose(ids[next]);
  radios[next]?.focus();
  return true;
}

function radiosOf(group: EventTarget | null): HTMLElement[] {
  if (!group || typeof (group as Element).querySelectorAll !== 'function') {
    return [];
  }
  return Array.from((group as Element).querySelectorAll<HTMLElement>('[role="radio"]'));
}
