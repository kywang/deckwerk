import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const script = resolve('packaging/linux/setup-sandbox.sh');
describe('Ubuntu sandbox profile setup', () => {
  it('limits namespace access to the exact executable, including paths with spaces', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deckwerk sandbox '));
    try {
      const binary = join(dir, 'deckwerk');
      writeFileSync(binary, '#!/bin/sh\nexit 0\n'); chmodSync(binary, 0o755);
      const result = spawnSync('bash', [script, '--print-profile', binary], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`"${realpathSync(binary)}" flags=(unconfined)`);
      expect(result.stdout).toContain('  userns,');
      expect(result.stdout).not.toContain('/**');
      const malicious = join(dir, 'wild*card');
      writeFileSync(malicious, ''); chmodSync(malicious, 0o755);
      expect(spawnSync('bash', [script, '--print-profile', malicious]).status).not.toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it('rejects a missing executable before touching system configuration', () => {
    expect(spawnSync('bash', [script, '--print-profile', '/nonexistent/deckwerk']).status).not.toBe(0);
  });
});
