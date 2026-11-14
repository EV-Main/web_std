import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Binding, type HelpRow, type Hint, type KeyInput, type Platform, type Step, Trie, platformOf, render } from '../src/index';

interface Case {
  why: string;
  platform?: Platform;
  unavailable?: string[];
  keys: (string | Partial<KeyInput>)[];
  steps: string[];
  hint?: Hint | null;
}

const F = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/keymap/keymap.json'), 'utf8')) as {
  keymap: Binding<string>[];
  cases: Case[];
  help: { platform: Platform; unavailable: string[]; rows: [string, string, string][] }[];
  invalid: { why: string; keymap: Binding<string>[]; panics: string }[];
};

const trie = (keymap: Binding<string>[], platform: Platform = 'other', unavailable: string[] = []) =>
  new Trie({ root: keymap }, platform, c => !unavailable.includes(c), c => c);

function input(k: string | Partial<KeyInput>): KeyInput {
  const raw = { key: '', code: '', ctrl: false, alt: false, meta: false, shift: false, repeat: false, composing: false, editable: false };
  if (typeof k !== 'string') return { ...raw, ...k };
  const editable = k.startsWith('!');
  const parts = (editable ? k.slice(1) : k).split('+');
  const key = parts.pop()!;
  const one = key.length === 1;
  return {
    ...raw,
    key,
    code: one && /[A-Za-z]/.test(key) ? `Key${key.toUpperCase()}` : one && /\d/.test(key) ? `Digit${key}` : one ? '' : key,
    ctrl: parts.includes('Ctrl'),
    alt: parts.includes('Alt'),
    meta: parts.includes('Meta'),
    shift: parts.includes('Shift') || key === 'Shift' || (one && /[A-Z]/.test(key)),
    editable,
  };
}

function spell(s: Step<string>): string {
  switch (s.kind) {
    case 'pass':
      return s.cancelled ? 'cancelled' : 'pass';
    case 'run':
      return `run ${s.command}: ${s.sequence}`;
    default:
      return s.kind;
  }
}

describe('keymap fixtures', () => {
  for (const c of F.cases) {
    it(c.why, () => {
      const t = trie(F.keymap, c.platform, c.unavailable);
      expect(c.keys.map(k => spell(t.key(input(k))))).toEqual(c.steps);
      if (c.hint !== undefined) expect(t.hint()).toEqual(c.hint ?? undefined);
    });
  }

  for (const h of F.help) {
    it(`help on ${h.platform} without [${h.unavailable.join(', ')}]`, () => {
      const rows: HelpRow[] = h.rows.map(([id, sequence, label]) => ({ id, sequence, label }));
      const t = trie(F.keymap, h.platform, h.unavailable);
      expect(t.help()).toEqual(rows);
      const ids = (bs: readonly Binding<string>[]): string[] => bs.flatMap(b => ('run' in b ? [b.id] : ids(b.children)));
      for (const id of ids(F.keymap)) expect(t.command(id), id).toBe(rows.find(r => r.id === id)?.label);
    });
  }

  for (const v of F.invalid) {
    it(`throws on ${v.why}`, () => {
      expect(() => trie(v.keymap)).toThrow(v.panics);
    });
  }
});

it('cancel drops the open scope', () => {
  const t = trie(F.keymap);
  expect(t.cancel()).toBe(false);
  t.key(input('Alt+s'));
  expect(t.cancel()).toBe(true);
  expect(t.hint()).toBeUndefined();
});

it('platforms', () => {
  for (const [p, want] of [['MacIntel', 'mac'], ['iPhone', 'mac'], ['iPad', 'mac'], ['Win32', 'other'], ['Linux x86_64', 'other'], ['', 'other']] as const)
    expect(platformOf(p)).toBe(want);
  const palette = { other: { key: 'k', ctrl: true }, mac: { key: 'k', meta: true } };
  expect([render(palette, 'mac'), render(palette, 'other')]).toEqual(['⌘K', 'Ctrl+K']);
});
