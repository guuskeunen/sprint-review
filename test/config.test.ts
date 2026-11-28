import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findConfigFile, loadConfig } from '../src/config.ts';

test('the config is found from a subfolder up to the repository root, and never above it', () => {
  const outside = mkdtempSync(join(tmpdir(), 'sprint-review-find-'));
  writeFileSync(join(outside, 'sprint-review.config.yml'), 'product:\n  name: Not this one\n');
  const repo = join(outside, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'apps', 'web'), { recursive: true });
  assert.equal(findConfigFile(join(repo, 'apps', 'web')), null, 'a config above the repository is not this project');
  writeFileSync(join(repo, 'sprint-review.config.yml'), 'product:\n  name: Spoke\n');
  assert.equal(findConfigFile(join(repo, 'apps', 'web')), join(repo, 'sprint-review.config.yml'));
  const config = loadConfig(null, join(repo, 'apps', 'web'));
  assert.equal(config.product.name, 'Spoke');
  assert.equal(config.root, repo);
});
