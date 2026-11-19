import { describe, expect, it } from 'vitest';
import { pageOf, shapeOf } from '../src/index';

describe('the crawl', () => {
  it('names a page by its URL without the #, its origin only when another host', () => {
    expect(pageOf('http://localhost:3000/fr#stats', 'http://localhost:3000')).toBe('/fr');
    expect(pageOf('/?assistant=sidebar', 'http://localhost:3000')).toBe('/?assistant=sidebar');
    expect(pageOf('http://localhost:52826/fr#points', 'http://localhost:3000')).toBe('http://localhost:52826/fr');
  });

  it('folds pages that differ only in numbers into one shape, and keeps states apart', () => {
    expect(shapeOf('/review_archive/gmbs/12')).toBe(shapeOf('/review_archive/gmbs/7'));
    expect(shapeOf('/?gmb=3&at=45.7,3.08,12')).toBe(shapeOf('/?at=1,2,3&gmb=41'));
    expect(shapeOf('/sites/leads?lead=aquafix.L-1')).toBe(shapeOf('/sites/leads?lead=aquafix.L-20'));
    expect(shapeOf('/?account=1&tab=launch')).not.toBe(shapeOf('/?account=1&tab=kit'));
    expect(shapeOf('/sites/leads')).not.toBe(shapeOf('/sites/places'));
  });
});
