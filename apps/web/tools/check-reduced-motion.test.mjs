/**
 * check-reduced-motion.test.mjs — FE8-003: prove the reduced-motion gate bites.
 *
 * Run: node --test apps/web/tools/check-reduced-motion.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.equal(blocks.length, 1);
    assert.match(blocks[0], /\.a/);
    assert.match(blocks[0], /\.c/);
    assert.doesNotMatch(blocks[0], /\.after/);
  });

  it('ignores media queries inside comments', () => {
    const blocks = reduceBlocks(stripComments('/* @media (prefers-reduced-motion: reduce) { } */'));
    assert.equal(blocks.length, 0);
  });
});

describe('isKillSwitch', () => {
  it('recognizes the global kill-switch', () => {
    assert.ok(isKillSwitch(reduceBlocks(KILL_SWITCH)[0]));
  });

  it('recognizes the minified kill-switch (.01ms, *:before)', () => {
    const minified =
      '@media(prefers-reduced-motion:reduce){*,*:before,*:after' +
      '{animation-duration:.01ms!important;transition-duration:.01ms!important}}';
    assert.ok(isKillSwitch(reduceBlocks(minified)[0]));
  });

  it('rejects a component-scoped rule as the global guarantee', () => {
    const block = reduceBlocks(`@media (prefers-reduced-motion: reduce) {
      .stage-icon { animation: none; }
    }`)[0];
    assert.ok(!isKillSwitch(block));
  });
});

describe('checkReducedMotion', () => {
  it('passes when the kill-switch exists and nothing re-enables motion', () => {
    const files = new Map([
      ['a.scss', '@keyframes spin { to { transform: rotate(1turn); } } .x { animation: spin 1s linear infinite; transition: opacity .2s; }'],
      ['b.scss', '@media (prefers-reduced-motion: reduce) { .y { animation: none; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    assert.equal(r.failures.length, 0);
    assert.equal(r.keyframes, 1);
    assert.equal(r.animations, 2); // spin usage + `animation: none`
    assert.equal(r.transitions, 1);
  });

  it('fails when the global kill-switch is missing', () => {
    const r = checkReducedMotion('body { color: red; }', new Map());
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /kill-switch/);
  });

  it('fails when a stylesheet re-enables a transition inside reduce', () => {
    const files = new Map([
      ['evil.scss', '@media (prefers-reduced-motion: reduce) { .z { transition-duration: 300ms; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /evil\.scss/);
  });

  it('fails when a stylesheet re-enables an animation inside reduce', () => {
    const files = new Map([
      ['evil.scss', '@media (prefers-reduced-motion: reduce) { .z { animation: pulse 2s infinite; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /re-enables motion/);
  });

  it('accepts zero durations inside reduce (redundant but harmless)', () => {
    const files = new Map([
      ['ok.scss', '@media (prefers-reduced-motion: reduce) { .z { animation-duration: 0s; transition: none; } }'],
    ]);
    const r = checkReducedMotion(KILL_SWITCH, files);
    assert.equal(r.failures.length, 0);
  });

  it('verifies the kill-switch survived compilation when built CSS is given', () => {
    const compiled = KILL_SWITCH.replace(/0\.01ms/g, '.01ms'); // minifier style
    const r = checkReducedMotion(KILL_SWITCH, new Map(), compiled);
    assert.equal(r.failures.length, 0);
  });

  it('fails when the built CSS lost the kill-switch', () => {
    const r = checkReducedMotion(KILL_SWITCH, new Map(), 'body{color:red}');
    assert.equal(r.failures.length, 1);
    assert.match(r.failures[0], /did not survive compilation/);
  });
});
