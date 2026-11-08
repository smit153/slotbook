// The "browser" lives in Berlin for every web test (Intl default zone = TZ), so
// browserZone() is deterministic and different from the NY test host.
process.env.TZ = 'Europe/Berlin';

import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no layout; keep scrollIntoView etc. harmless.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

afterEach(() => {
  cleanup();
});
