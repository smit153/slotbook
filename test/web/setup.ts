import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no layout; keep scrollIntoView etc. harmless.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

afterEach(() => {
  cleanup();
});
