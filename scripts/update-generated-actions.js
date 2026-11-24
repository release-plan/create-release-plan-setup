import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import ejs from 'ejs';
import semver from 'semver';

const templates = ['plan-release-template.yml.ejs', 'publish-template.yml.ejs'];
const variants = [
  { pnpm: false, hasPackageManager: false, defaultBranch: 'main' },
  { pnpm: true, hasPackageManager: false, defaultBranch: 'main' },
  { pnpm: true, hasPackageManager: true, defaultBranch: 'main' },
];

export function generatedReferences(contents, filename) {
  const references = new Map();
  for (const options of variants) {
    const output = ejs.render(contents, options);
    for (const line of output.split('\n')) {
      const uses = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/);
      if (!uses || uses[1].startsWith('./')) continue;
      const match = uses[1].match(/^([^/]+\/[^/@]+)(?:\/[^@]+)?@([a-f0-9]{40})$/);
      const version = uses[2].match(/^\s+#\s*(v?\d+\.\d+\.\d+)\s*$/)?.[1];
      if (!match || !version || !semver.valid(version)) {
        throw new Error(
          `Expected a SHA-pinned action with a version comment in ${filename}: ${line}`
        );
      }
      if (references.has(uses[1]) && references.get(uses[1]).version !== version) {
        throw new Error(`Conflicting version comments for ${uses[1]}`);
      }
      references.set(uses[1], { reference: uses[1], repo: match[1], sha: match[2], version });
    }
  }
  return [...references.values()];
}

// The scheduled workflow runs on Node 24.
// eslint-disable-next-line n/no-unsupported-features/node-builtins
export async function fetchTags(repo, token, fetchImpl = fetch) {
  const tags = [];
  for (let page = 1; ; page++) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repo}/tags?per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );
    if (!response.ok) {
      throw new Error(
        `Cannot fetch tags for ${repo}: HTTP ${response.status} ${await response.text()}`
      );
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error(`Invalid tags response for ${repo}`);
    tags.push(...batch);
    if (batch.length < 100) return tags;
  }
}

export async function updateTemplates(templateContents, getTags) {
  const refs = new Map();
  for (const [filename, contents] of Object.entries(templateContents)) {
    for (const ref of generatedReferences(contents, filename)) {
      const existing = refs.get(ref.reference);
      if (existing && existing.version !== ref.version) {
        throw new Error(`Conflicting version comments for ${ref.reference}`);
      }
      refs.set(ref.reference, ref);
    }
  }
  if (refs.size === 0) throw new Error('No generated action references found');

  const tagsByRepo = new Map();
  for (const { repo } of refs.values()) {
    if (!tagsByRepo.has(repo)) tagsByRepo.set(repo, await getTags(repo));
  }
  const updated = { ...templateContents };
  for (const { reference, repo, sha, version } of refs.values()) {
    const stableTags = tagsByRepo
      .get(repo)
      .filter((tag) => semver.valid(tag.name) && !semver.prerelease(tag.name))
      .sort((a, b) => semver.rcompare(a.name, b.name));
    const current = stableTags.find((tag) => tag.name === version);
    if (!current || current.commit?.sha !== sha) {
      throw new Error(`Tag ${repo}@${version} does not match the pinned commit ${sha}`);
    }
    const latest = stableTags[0];
    if (semver.lte(latest.name, version)) continue;
    if (!/^[a-f0-9]{40}$/.test(latest.commit?.sha)) {
      throw new Error(`Invalid commit for ${repo}@${latest.name}`);
    }
    let replacements = 0;
    const pattern = new RegExp(
      `${reference.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]+#[ \\t]*${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s<]|$)`,
      'g'
    );
    for (const [filename, contents] of Object.entries(updated)) {
      updated[filename] = contents.replace(pattern, () => {
        replacements++;
        return `${reference.replace(sha, latest.commit.sha)} # ${latest.name}`;
      });
    }
    if (replacements === 0) throw new Error(`Cannot locate ${reference} in its template`);
  }
  return updated;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required to fetch action tags');
  const contents = Object.fromEntries(
    await Promise.all(templates.map(async (file) => [file, await readFile(file, 'utf8')]))
  );
  const updated = await updateTemplates(contents, (repo) => fetchTags(repo, token));
  for (const file of templates) {
    if (updated[file] !== contents[file]) {
      await writeFile(file, updated[file]);
      console.log(`Updated ${file}`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
