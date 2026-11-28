import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rangeFor } from '../../src/review/generate.ts';

const cli = (o: string) => `--${o}`;

test('a range asked for is checked: real dates, in order, and refs or dates but not both', () => {
  assert.deepEqual(rangeFor({ since: '2026-11-18', until: '2026-11-25', to: 'origin/develop' }, 14), { kind: 'dates', from: '2026-11-18', until: '2026-11-25', at: 'origin/develop' });
  assert.deepEqual(rangeFor({ from: 'v1.4.0' }, 14), { kind: 'refs', from: 'v1.4.0', to: 'HEAD' });
  assert.throws(() => rangeFor({ since: '2026-13-40' }, 14, cli), /--since must be a real date like 2026-11-10, not 2026-13-40/);
  assert.throws(() => rangeFor({ since: '2026-02-30' }, 14, cli), /not 2026-02-30/);
  assert.throws(() => rangeFor({ since: '18-11-2026' }, 14, cli), /--since must be a real date/);
  assert.throws(() => rangeFor({ since: '2026-11-25', until: '2026-11-18' }, 14, cli), /--since \(2026-11-25\) is after --until \(2026-11-18\)/);
  assert.throws(() => rangeFor({ since: '2999-01-01' }, 14, cli), /is after today/);
  assert.throws(() => rangeFor({ since: '2026-11-18', from: 'v1.4.0' }, 14, cli), /Use --from or dates \(--since, --until\), not both/);
  // The MCP server names its arguments without dashes.
  assert.throws(() => rangeFor({ since: 'soon' }, 14), /^Error: since must be a real date/);
});
