import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { type At, type Carried, type Table, ViewError, href, mayOpen, parse } from '../src/index';

// The Rust writes these (`rust/tests/views.rs`, `BLESS=1`); both codecs answer them alike.
const F = JSON.parse(readFileSync(join(import.meta.dirname, '../../../tests/fixtures/views/views.json'), 'utf8')) as {
  table: Table;
  cases: { at: At<Table>; carried: Carried<Table>; href: string }[];
  refused: string[];
  may: { view: At<Table>['view']; permissions: string[]; may: boolean }[];
};

describe('views fixtures', () => {
  for (const c of F.cases) {
    it(`${c.at.view} ⇄ ${c.href}`, () => {
      expect(href(F.table, c.at, c.carried)).toBe(c.href);
      expect(parse(F.table, c.href)).toEqual({ at: c.at, carried: c.carried });
    });
  }
  for (const m of F.may) {
    it(`${m.view} opens for [${m.permissions.join(', ')}]: ${m.may}`, () => {
      expect(mayOpen(F.table, m.view, m.permissions)).toBe(m.may);
    });
  }
  for (const h of F.refused) {
    it(`${h} is no view`, () => {
      expect(() => parse(F.table, h)).toThrow(ViewError);
    });
  }
});

it('types a view by its table', () => {
  const VIEWS = {
    carried: { type: 'object', properties: { find: { type: ['string', 'null'] } }, required: [] },
    views: {
      gmb: {
        path: '/gmbs/{gmb}',
        description: "A GMB's board.",
        params: { type: 'object', properties: { gmb: { type: 'integer' } }, required: ['gmb'] },
        query: {
          type: 'object',
          properties: {
            tab: { type: ['string', 'null'], enum: ['launch', 'kit', null] },
            trash: { type: 'boolean' },
            at: { type: ['array', 'null'], prefixItems: [{ type: 'number' }, { type: 'number' }] },
          },
          required: [],
        },
      },
      home: { path: '/', description: 'The map.', params: { type: 'object', properties: {}, required: [] }, query: { type: 'object', properties: {}, required: [] }, key: 'h' },
    },
  } as const satisfies Table;
  expectTypeOf<At<typeof VIEWS>>().toEqualTypeOf<
    { view: 'gmb'; params: { gmb: number; tab?: 'launch' | 'kit'; trash?: boolean; at?: [number, number] } } | { view: 'home'; params: {} }
  >();
  expectTypeOf<Carried<typeof VIEWS>>().toEqualTypeOf<{ find?: string }>();
  expect(href(VIEWS, { view: 'gmb', params: { gmb: 5, tab: 'kit', at: [1.5, 2] } }, { find: 'x' })).toBe('/gmbs/5?at=1.5%2C2&find=x&tab=kit');
});
