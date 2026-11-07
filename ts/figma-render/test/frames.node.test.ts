import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { frameKey, frames } from '../src/frames';
import { defineFigmaSuite } from '../src/index';

const list = JSON.parse(readFileSync(new URL('./fixtures/list.json', import.meta.url), 'utf8'));

describe('frames', () => {
  it('keys every @figma spec by project, in the list order', () => {
    expect(frames(list).map(frameKey)).toEqual(
      ['desktop', 'mobile', 'tablet'].flatMap(p =>
        ['/fr', '/fr/prices', '/fr/about', 'http://localhost:52826/fr', '/fr/nope', '/fr/thanks'].map(page => `${p} ${page}`),
      ),
    );
  });

  it('refuses a list that failed to load', () => {
    expect(() => frames({ suites: [], errors: [{ message: 'SyntaxError' }] })).toThrow(/SyntaxError/);
  });
});

describe('defineFigmaSuite', () => {
  it('names a page by its URL without the #: sections of one page share it, a query is a page of its own', () => {
    const titles: string[] = [];
    const test = Object.assign((title: string) => void titles.push(title), { describe: (_: string, body: () => void) => body(), use: () => {} });
    defineFigmaSuite({ test: test as never }, [
      { name: 'hero', url: '/fr', selector: 'main' },
      { name: 'stats', url: '/fr#stats', selector: '#stats' },
      { name: 'assistant', url: '/fr?assistant=sidebar', selector: 'aside' },
      { name: 'points', url: 'http://localhost:52826/fr#points', selector: '#points' },
    ]);
    expect(titles).toEqual(['/fr', '/fr?assistant=sidebar', 'http://localhost:52826/fr']);
  });
});
