const local = require('../../scripts/lib/gotrue-local.cjs');

describe('real GoTrue disposable runner safety', () => {
  it('requires explicit local mutation authorization and Node 22', () => {
    expect(() => local.assertLocalRun([], '22.20.0')).toThrow();
    expect(() => local.assertLocalRun(['--allow-local-migrations'], '24.0.0')).toThrow();
    expect(() => local.assertLocalRun(['--allow-local-migrations'], '22.20.0')).not.toThrow();
  });
  it.each(['https://remote.invalid', 'http://localhost:1234', 'http://127.0.0.1:4321', 'http://user:pass@127.0.0.1:1234', 'file:///secret'])('blocks unregistered or non-loopback URL %s', input => {
    expect(local.isAllowedUrl(input, new Set(['http://127.0.0.1:1234']))).toBe(false);
  });
  it('accepts only registered loopback origins', () => {
    expect(local.isAllowedUrl('http://127.0.0.1:1234/auth/v1/user', new Set(['http://127.0.0.1:1234']))).toBe(true);
  });
  it('refuses cleanup of containers without the exact ownership label', () => {
    expect(() => local.assertOwnedContainer({ Config: { Labels: {} } }, 'run')).toThrow();
    expect(() => local.assertOwnedContainer({ Config: { Labels: { 'uniconnect.gotrue.run': 'other' } } }, 'run')).toThrow();
    expect(() => local.assertOwnedContainer({ Config: { Labels: { 'uniconnect.gotrue.run': 'run' } } }, 'run')).not.toThrow();
  });
  it.each(['0.0.0.0:1234', '[::]:1234', '127.0.0.1:1234\n0.0.0.0:4321', '127.0.0.1:0'])('refuses unsafe published binding %s', binding => {
    expect(() => local.loopbackOrigin(binding)).toThrow();
  });
  it('validates loopback port before creating an origin', () => {
    expect(local.loopbackOrigin('127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
  });
  it('extracts captured proofs without visiting the confirmation link', () => {
    const origin = 'http://127.0.0.1:1234';
    expect(local.capturedProof(`<a href="${origin}/verify?token=abc123&amp;type=recovery">Reset</a>`, origin, 'recovery')).toBe('abc123');
    expect(() => local.capturedProof('<a href="https://remote.invalid/verify?token=abc123&type=recovery">Reset</a>', origin, 'recovery')).toThrow();
    expect(() => local.capturedProof(`<a href="${origin}/verify?token=abc123&type=invite">Reset</a>`, origin, 'recovery')).toThrow();
  });
  it.each(['real@example.com', 'user@invalid', 'evil@p04.invalid\r\nRCPT TO:real@example.com'])('rejects non-synthetic recipient %s', email => {
    expect(() => local.assertSyntheticEmail(email)).toThrow();
  });
  it('allows only reserved synthetic domains', () => {
    expect(() => local.assertSyntheticEmail('actor@p04.invalid')).not.toThrow();
  });
});
