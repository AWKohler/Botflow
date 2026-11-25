/**
 * The simulator stream's wire details the browser has to get right: which
 * panel a video chunk belongs to, and which keys go to the device.
 */
import { describe, expect, test } from 'vitest';
import { simInputForKey } from './sim-key-input';
import { SIM_STREAM_INDEX, decodeVideoFlags } from './swift-stream-client';

describe('video chunk flags', () => {
  test('a single-screen stream reads as before: bit 0 is the keyframe', () => {
    expect(decodeVideoFlags(0)).toEqual({ keyframe: false, streamIndex: 0 });
    expect(decodeVideoFlags(1)).toEqual({ keyframe: true, streamIndex: 0 });
  });

  test('bits 1–2 carry the Duo panel', () => {
    expect(decodeVideoFlags(0b010)).toEqual({ keyframe: false, streamIndex: SIM_STREAM_INDEX.inner });
    expect(decodeVideoFlags(0b011)).toEqual({ keyframe: true, streamIndex: SIM_STREAM_INDEX.inner });
    expect(SIM_STREAM_INDEX.cover).toBe(0);
  });

  test('higher bits are ignored', () => {
    expect(decodeVideoFlags(0b11110001)).toEqual({ keyframe: true, streamIndex: 0 });
  });
});

describe('keys for the device', () => {
  const key = (k: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
    simInputForKey({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...mods });

  test('printable characters are typed', () => {
    expect(key('a')).toEqual({ kind: 'text', text: 'a' });
    expect(key(' ')).toEqual({ kind: 'text', text: ' ' });
  });
  test('named keys go by name', () => {
    expect(key('Enter')).toEqual({ kind: 'key', key: 'Enter' });
    expect(key('Backspace')).toEqual({ kind: 'key', key: 'Backspace' });
  });
  test('browser shortcuts and keys the device has no use for stay with the browser', () => {
    expect(key('c', { metaKey: true })).toBeNull();
    expect(key('v', { ctrlKey: true })).toBeNull();
    expect(key('F5')).toBeNull();
    expect(key('Shift')).toBeNull();
  });
});
