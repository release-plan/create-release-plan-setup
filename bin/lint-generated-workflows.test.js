import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = path.join(root, 'bin/release-plan-setup.js');

const knownFindings = [];

async function audit(workflows, cwd, label, { report = true } = {}) {
  const args = [
    '--offline',
    '--no-config',
    '--no-ignores',
    '--strict-collection',
    '--no-progress',
    '--no-exit-codes',
    ...workflows,
  ];
  const { stdout } = await execa('zizmor', ['--format', 'json', ...args], { cwd });
  const findings = JSON.parse(stdout);
  if (report && findings.length > 0) {
    const diagnostics = await execa('zizmor', args, { cwd });
    console.log(`zizmor audit: ${label}\n${diagnostics.stdout}`);
    if (diagnostics.stderr) {
      console.error(diagnostics.stderr);
    }
  }
  return findings.map((finding) => {
    const primary = finding.locations.find((location) => location.symbolic.kind === 'Primary');
    return `${path.basename(primary.symbolic.key.Local.verbatim_path)}:${finding.ident}:${primary.concrete.feature}`;
  });
}

describe('lint generated workflows', () => {
  let directory;

  afterEach(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    { kind: 'npm', packageManager: undefined },
    { kind: 'pnpm', packageManager: undefined },
    { kind: 'pnpm', packageManager: 'pnpm@9.5.0' },
  ])('Lints $kind workflows (packageManager: $packageManager)', async (variant) => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'release-plan-setup-'));
    const remote = path.join(directory, 'remote.git');
    const project = path.join(directory, 'project');
    const gitEnvironment = { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1' };
    await mkdir(project);
    await execa('git', ['init', '--bare', '--initial-branch=release/next', remote], {
      env: gitEnvironment,
    });
    await execa('git', ['init', '--initial-branch=release/next'], {
      cwd: project,
      env: gitEnvironment,
    });
    await execa(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'Initial commit',
      ],
      { cwd: project, env: gitEnvironment }
    );
    await execa('git', ['remote', 'add', 'origin', remote], { cwd: project, env: gitEnvironment });
    await execa('git', ['push', 'origin', 'release/next'], { cwd: project, env: gitEnvironment });
    await writeFile(
      path.join(project, 'package.json'),
      JSON.stringify({
        name: 'example-package',
        version: '1.0.0',
        repository: 'https://github.com/example/example-package.git',
        ...(variant.packageManager && { packageManager: variant.packageManager }),
      })
    );
    if (variant.kind === 'pnpm') {
      await writeFile(path.join(project, 'pnpm-lock.yaml'), '');
    }

    await execa(process.execPath, [bin, '--no-install', '--no-label-updates'], {
      cwd: project,
      env: gitEnvironment,
    });

    const workflows = ['.github/workflows/plan-release.yml', '.github/workflows/publish.yml'];
    const findings = await audit(workflows, project, `generated ${variant.kind} workflows`);
    expect(findings.filter((finding) => !knownFindings.includes(finding))).toEqual([]);
    expect(new Set(findings).size).toBe(findings.length);

    if (variant.kind === 'npm') {
      const publish = await readFile(path.join(project, workflows[1]), 'utf8');
      await writeFile(
        path.join(project, workflows[1]),
        `${publish}\n      - run: echo "\${{ github.event.pull_request.title }}"\n`
      );
      const injectedFindings = await audit(workflows, project, 'deliberately injected workflow', {
        report: false,
      });
      expect(
        injectedFindings.some((finding) => finding.includes(':template-injection:')),
        'zizmor should detect a deliberately introduced template injection'
      ).toBe(true);
    }
  });
});
