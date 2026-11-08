import { expect, it } from 'vitest';
import { browserZone } from '../../src/web/lib/time.js';

it('the test browser is in Europe/Berlin', () => {
  expect(browserZone()).toBe('Europe/Berlin');
});
