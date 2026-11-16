import { afterEach, describe, expect, it } from 'vitest';
import { handleRadioGroupKeydown, radioTabIndex } from './radio-group';

const IDS = ['a', 'b', 'c'] as const;

/** Groups attached to document.body, removed after each test (#946). */
const attached: HTMLElement[] = [];

// Vitest shares the DOM across spec files in a worker: leaving focused radios
// behind broke focus assertions in other specs (route-focus.service.spec).
afterEach(() => {
  attached.splice(0).forEach((el) => el.remove());
});

/** A radiogroup with one button per id, attached so focus() works. */
function group(): { el: HTMLElement; radios: HTMLButtonElement[] } {
  const el = document.createElement('div');
  el.setAttribute('role', 'radiogroup');
  const radios = IDS.map((id) => {
    const b = document.createElement('button');
    b.setAttribute('role', 'radio');
    b.dataset['id'] = id;
    el.appendChild(b);
    return b;
  });
  document.body.appendChild(el);
  attached.push(el);
  return { el, radios };
}

function press(target: HTMLElement, key: string): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

// Specs share one jsdom document: remove the attached groups (and the focus
// they hold) so later specs start from a clean body.
afterEach(() => {
  document.querySelectorAll('[role="radiogroup"]').forEach((el) => el.remove());
});

describe('radioTabIndex (#937 roving tabindex)', () => {
  it('makes only the checked radio a Tab stop', () => {
    expect(IDS.map((id) => radioTabIndex(IDS, 'b', id))).toEqual([-1, 0, -1]);
  });

  it('falls back to the first radio when nothing (or an unknown value) is checked', () => {
    expect(IDS.map((id) => radioTabIndex(IDS, null, id))).toEqual([0, -1, -1]);
    expect(IDS.map((id) => radioTabIndex<string>(IDS, 'zzz', id))).toEqual([0, -1, -1]);
  });
});

describe('handleRadioGroupKeydown (#937)', () => {
  function wire(selected: string | null) {
    const { el, radios } = group();
    const chosen: string[] = [];
    el.addEventListener('keydown', (e) =>
      handleRadioGroupKeydown(e as KeyboardEvent, IDS, selected, (id) => chosen.push(id)),
    );
    return { el, radios, chosen };
  }

  it('ArrowRight/ArrowDown select and focus the next radio, wrapping', () => {
    const { radios, chosen } = wire('c');
    radios[2].focus();
    const e = press(radios[2], 'ArrowDown');
    expect(e.defaultPrevented).toBe(true);
    expect(chosen).toEqual(['a']);
    expect(document.activeElement).toBe(radios[0]);
  });

  it('ArrowLeft/ArrowUp select and focus the previous radio, wrapping', () => {
    const { radios, chosen } = wire('a');
    radios[0].focus();
    press(radios[0], 'ArrowLeft');
    expect(chosen).toEqual(['c']);
    expect(document.activeElement).toBe(radios[2]);
  });

  it('moves from the focused radio, not just the checked one', () => {
    const { radios, chosen } = wire(null);
    radios[0].focus();
    press(radios[0], 'ArrowRight');
    expect(chosen).toEqual(['b']);
    expect(document.activeElement).toBe(radios[1]);
  });

  it('Home and End jump to the first and last radio', () => {
    const { radios, chosen } = wire('b');
    press(radios[1], 'End');
    press(radios[1], 'Home');
    expect(chosen).toEqual(['c', 'a']);
    expect(document.activeElement).toBe(radios[0]);
  });

  it('leaves Tab, Space and Enter to the browser', () => {
    const { radios, chosen } = wire('a');
    for (const key of ['Tab', ' ', 'Enter']) {
      expect(press(radios[0], key).defaultPrevented).toBe(false);
    }
    expect(chosen).toEqual([]);
  });

  it('falls back to the checked value when the key lands on the group itself', () => {
    const { el, chosen } = wire('b');
    press(el, 'ArrowRight');
    expect(chosen).toEqual(['c']);
  });
});
