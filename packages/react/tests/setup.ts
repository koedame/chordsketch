import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// `@testing-library/react` mounts components into a shared `document.body`.
// Without explicit cleanup the body accumulates nodes across tests in the
// same file, which turns `getByRole('button')` into an ambiguous match.
// Running `cleanup()` after every test restores the single-root invariant.
afterEach(() => {
  cleanup();
});
