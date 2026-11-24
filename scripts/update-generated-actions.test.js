import { readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import { fetchTags, generatedReferences, updateTemplates } from './update-generated-actions.js';

const oldSha = 'a'.repeat(40);
const newSha = 'b'.repeat(40);
const tags = [
  { name: 'v1.0.0', commit: { sha: oldSha } },
  { name: 'v2.0.0', commit: { sha: newSha } },
  { name: 'v3.0.0-beta.1', commit: { sha: 'c'.repeat(40) } },
  { name: 'v3', commit: { sha: 'd'.repeat(40) } },
];

describe('generated action updates', () => {
  it('audits all generated variants and updates all occurrences, including subactions', async () => {
    const contents = {
      'plan.yml.ejs': `- uses: example/action/first@${oldSha} # v1.0.0
- uses: example/action/second@${oldSha} # v1.0.0`,
      'publish.yml.ejs': `<% if (pnpm) { %>
- uses: example/action/first@${oldSha} #v1.0.0<% } %>`,
    };
    const getTags = vi.fn().mockResolvedValue(tags);
    const updated = await updateTemplates(contents, getTags);
    expect(getTags).toHaveBeenCalledTimes(1);
    expect(updated['plan.yml.ejs']).toBe(`- uses: example/action/first@${newSha} # v2.0.0
- uses: example/action/second@${newSha} # v2.0.0`);
    expect(updated['publish.yml.ejs']).toContain(`example/action/first@${newSha} # v2.0.0<% } %>`);
    expect(await updateTemplates(updated, getTags)).toEqual(updated);
  });

  it('discovers the action references in the actual templates for npm and pnpm', async () => {
    const plan = await readFile('plan-release-template.yml.ejs', 'utf8');
    const publish = await readFile('publish-template.yml.ejs', 'utf8');
    expect(generatedReferences(plan, 'plan').map((ref) => ref.repo)).toEqual([
      'release-plan/actions',
      'release-plan/actions',
      'peter-evans/create-pull-request',
    ]);
    expect(generatedReferences(publish, 'publish').map((ref) => ref.repo)).toEqual([
      'actions/checkout',
      'actions/setup-node',
      'pnpm/action-setup',
    ]);
  });

  it('rejects unpinned references, conflicting comments, and moved tags', async () => {
    expect(() => generatedReferences('- uses: example/action@v1', 'test')).toThrow('SHA-pinned');
    expect(() =>
      generatedReferences(
        `- uses: example/action@${oldSha} # v1.0.0\n- uses: example/action@${oldSha} # v1.1.0`,
        'test'
      )
    ).toThrow('Conflicting');
    await expect(
      updateTemplates({ test: `- uses: example/action@${oldSha} # v1.0.0` }, async () => [
        { name: 'v1.0.0', commit: { sha: newSha } },
      ])
    ).rejects.toThrow('does not match');
  });

  it('fetches all pages of tags and reports API failures', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => Array(100).fill(tags[0]) })
      .mockResolvedValueOnce({ ok: true, json: async () => [tags[1]] });
    expect(await fetchTags('example/action', 'token', fetchImpl)).toHaveLength(101);
    expect(fetchImpl.mock.calls[1][0]).toContain('page=2');
    await expect(
      fetchTags('example/action', 'token', async () => ({
        ok: false,
        status: 403,
        text: async () => 'rate limited',
      }))
    ).rejects.toThrow('HTTP 403 rate limited');
  });
});
