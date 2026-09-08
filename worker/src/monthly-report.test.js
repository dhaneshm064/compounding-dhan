import test from 'node:test';
import assert from 'node:assert/strict';

import { assertCompleteCommittee } from './monthly-report.js';

test('accepts only a complete investment committee', () => {
  assert.doesNotThrow(() => assertCompleteCommittee({ status: 'complete' }));
});

test('rejects partial committee output before report persistence', () => {
  assert.throws(
    () => assertCompleteCommittee({ status: 'partial', errors: ['philosophy steward returned malformed JSON'] }),
    /Monthly report not generated.*philosophy steward returned malformed JSON/
  );
});

test('rejects unavailable committee output before report persistence', () => {
  assert.throws(
    () => assertCompleteCommittee({ status: 'unavailable', error: 'AI binding unavailable' }),
    /Monthly report not generated.*AI binding unavailable/
  );
});
