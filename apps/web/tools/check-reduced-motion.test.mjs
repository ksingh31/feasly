/**
 * check-reduced-motion.test.mjs — FE8-003: prove the reduced-motion gate bites.
 *
 * Run: vitest run tools/check-reduced-motion.test.mjs
 */
import { describe, expect, it } from 'vitest';
import {
  checkReducedMotion,
  reduceBlocks,
  isKillSwitch,
  stripComments,
} from './check-reduced-motion.mjs';

const KILL_SWITCH = `
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}`;

describe('reduceBlocks', () => {
  it('extracts the block body across nested rules', () => {
    const css = `@media (prefers-reduced-motion: reduce) {
      .a { animation: none; }
      .b { .c { transition: none; } }
    } .after { color: red; }`;
    const blocks = reduceBlocks(css);
    expect(blocks.length).toBe(1);
    expect(blocks[0]).toMatch(/\.a/);
    expect(blocks[0]).toMatch(/\.c/);
    expect(blocks[0]).not.toMatch(/\.after/);
  });

  it('ignores media queries inside comments', () => {
    const blocks = reduceBlocks(stripComments('/* @media (prefers-reduced-motion: reduce) { } */'));
    expect(blocks.length).toBe(0);
  });
});

describe('isKillSwitch', () => {
  it('recognizes the global kill-switch', () => {
    expect(isKillSwitch(reduceBlocks(KILL_SWITCH)[0])).toBeTruthy();
  });

  it('recognizes the minified kill-switch (.01ms, *:before)', () => {
    const minified =
      '@media(prefers-reduced-motion:reduce){*,*:before,*:after' +
      '{animation-duration:.01ms!important;transition-duration:.01ms!important}}';
    expect(isKillSwitch(reduceBlocks(minified)[0])).toBeTruthy();
  });

  it('rejects a component-scoped rule as the global guarantee', () => {
    const block = reduceBlocks(`@media (prefers-reduced-motion: reduce) {
      .stage-icon { animation: none; }
    }`)[0];
    expect(isKillSwitch(block)).toBeFalsy();
  });
});

describe('checkReducedMotion', () => {
  it('passes when the kill-switch exists and nothing re-enables motion', () => {
    const files = new Map([
      ['a.scss', '@keyframes spin { to { transform: rotate(1turn); } } .x { animation: spin 1s linear infinite; transition: opacity .2s; }'],
      ['b.scss', '@media (prefers-reduced-motion: reduce) { .y { animation: none; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    expect(r.failures.length).toBe(0);
    expect(r.keyframes).toBe(1);
    expect(r.animations).toBe(2); // spin usage + `animation: none`
    expect(r.transitions).toBe(1);
  });

  it('fails when the global kill-switch is missing', () => {
    const r = checkReducedMotion('body { color: red; }', new Map());
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toMatch(/kill-switch/);
  });

  it('fails when a stylesheet re-enables a transition inside reduce', () => {
    const files = new Map([
      ['evil.scss', '@media (prefers-reduced-motion: reduce) { .z { transition-duration: 300ms; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toMatch(/evil\.scss/);
  });

  it('fails when a stylesheet re-enables an animation inside reduce', () => {
    const files = new Map([
      ['evil.scss', '@media (prefers-reduced-motion: reduce) { .z { animation: pulse 2s infinite; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toMatch(/re-enables motion/);
  });

  it('accepts zero durations inside reduce (redundant but harmless)', () => {
    const files = new Map([
      ['ok.scss', '@media (prefers-reduced-motion: reduce) { .z { animation-duration: 0s; transition: none; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    expect(r.failures.length).toBe(0);
  });

  it('verifies the kill-switch survived compilation when built CSS is given', () => {
    const compiled = KILL_SWITCH.replace(/0\.01ms/g, '.01ms'); // minifier style
    const r = checkReducedMotion(KILL_SWITCH, new Map(), compiled);
    expect(r.failures.length).toBe(0);
  });

  it('fails when the built CSS lost the kill-switch', () => {
    const r = checkReducedMotion(KILL_SWITCH, new Map(), 'body{color:red}');
    expect(r.failures.length).toBe(1);
    expect(r.failures[0]).toMatch(/did not survive compilation/);
  });
});
