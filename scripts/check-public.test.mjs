// The check that nothing internal is in this repository (scripts/check-public.mjs). Run with `node --test scripts/check-public.test.mjs`.
//
// The references below are put together at run time, so this file passes the check itself.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { findBadIcon, findInternal } from './check-public.mjs';

const HASH = '#';
const PRIVATE = ['nxisai', 'some-private-repo'].join('/');
const hits = (s, hidden) => findInternal(s, hidden).map((p) => p.why);

test('finds private repositories, issue references and internal hosts', () => {
  assert.deepEqual(hits(`see github.com/${PRIVATE} for more`), ['a private repository']);
  assert.deepEqual(hits(`fixed in nxisai/skills${HASH}12`), ['an issue or pull request reference']);
  assert.deepEqual(hits(`as decided in (${HASH}75)`), ['a bare issue or pull request number']);
  assert.deepEqual(hits(['https://api-abc123-uc.a', 'run.app/v1'].join('.')), ['a cloud or tunnel host']);
  assert.deepEqual(hits(['http://db.prod', 'internal:5432'].join('.')), ['an internal host']);
  assert.deepEqual(hits(['write to someone', 'corp-mail.io'].join('@')), ['an email address']);
});

test('finds a hidden name by its hash', () => {
  const hidden = new Set([createHash('sha256').update('made-up-service').digest('hex')]);
  assert.deepEqual(hits('calls Made-Up-Service directly', hidden), ['an internal name']);
});

test('allows the public repositories, Terraform, CSS colors and placeholder addresses', () => {
  assert.deepEqual(findInternal('npx skills add nxisai/skills; git clone https://github.com/nxisai/agent-harness.git'), []);
  assert.deepEqual(findInternal('curl -fsSL https://github.com/nxisai/cli/releases/latest/download/install.sh | sh'), []);
  assert.deepEqual(hits(`see ${['nxisai', 'cli-internal'].join('/')}`), ['a private repository']);
  assert.deepEqual(findInternal('Deploy it with Terraform: terraform apply'), []);
  assert.deepEqual(findInternal(`color: ${HASH}000; background: light-dark(${HASH}eee, ${HASH}111)`), []);
  assert.deepEqual(findInternal('you@example.com, git@github.com, a@b.test'), []);
  assert.deepEqual(findInternal('BASE_URL=http://host.docker.internal:4130 or gateway.docker.internal'), []);
});

test('a skill icon is a Heroicons name, not an emoji', () => {
  const skill = (icon) => `---\nname: x\ndisplay_name: X\n${icon}\nsource: NXISAI\n---\n\nBody\n`;
  assert.deepEqual(findBadIcon(skill('icon: rocket-launch'), 'skills/x/SKILL.md'), []);
  assert.deepEqual(findBadIcon(skill('icon: "chat-bubble-left-right"'), 'skills/x/SKILL.md'), []);
  assert.equal(findBadIcon(skill('icon: \u{1F680}'), 'skills/x/SKILL.md')[0].line, 4);
  assert.equal(findBadIcon(skill('icon: Rocket Launch'), 'skills/x/SKILL.md').length, 1);
  assert.equal(findBadIcon(skill('source: x'), 'skills/x/SKILL.md').length, 1);
  assert.deepEqual(findBadIcon(skill('icon: \u{1F680}'), 'README.md'), []);
});
