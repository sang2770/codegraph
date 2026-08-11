import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as vscode from 'vscode';

export interface ProjectMarkers {
  /** Dependency and devDependency names from `package.json`. */
  nodeDependencies: string[];
  /** Script names declared in `package.json`. */
  nodeScripts: string[];
  packageManager: 'npm' | 'pnpm' | 'yarn' | undefined;
  hasPackageJson: boolean;
  hasPytestConfig: boolean;
  hasGoMod: boolean;
  hasCargoToml: boolean;
  hasPomXml: boolean;
  hasGradle: boolean;
  hasDotnetProject: boolean;
  hasGemfile: boolean;
  hasComposerJson: boolean;
}

export interface TestCommand {
  label: string;
  detail: string;
  command: string;
}

/** Quote a path for a shell command line. */
function quote(value: string): string {
  return /[\s"'$`\\&|;<>()*?!#~]/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

function fileList(files: readonly string[]): string {
  return files.map(quote).join(' ');
}

/** Unique parent directories of the given files, as `./dir` package paths. */
function packageDirs(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const file of files) {
    const dir = dirname(file).replaceAll('\\', '/');
    dirs.add(dir === '.' ? './' : `./${dir}`);
  }
  return [...dirs].sort();
}

function runner(markers: ProjectMarkers): string {
  switch (markers.packageManager) {
    case 'pnpm':
      return 'pnpm exec';
    case 'yarn':
      return 'yarn';
    default:
      return 'npx';
  }
}

/**
 * Candidate commands that would run exactly `testFiles`, most specific first.
 *
 * Pure so the detection table is testable without a real project on disk.
 */
export function buildTestCommands(
  markers: ProjectMarkers,
  testFiles: readonly string[],
): TestCommand[] {
  const commands: TestCommand[] = [];
  const files = fileList(testFiles);
  const dependencies = new Set(markers.nodeDependencies);
  const exec = runner(markers);

  if (dependencies.has('vitest')) {
    commands.push({
      label: 'Vitest',
      detail: 'Run only the affected test files',
      command: `${exec} vitest run ${files}`,
    });
  }
  if (dependencies.has('jest')) {
    commands.push({
      label: 'Jest',
      detail: 'Run only the affected test files',
      command: `${exec} jest ${files}`,
    });
  }
  if (dependencies.has('@playwright/test')) {
    commands.push({
      label: 'Playwright',
      detail: 'Run only the affected spec files',
      command: `${exec} playwright test ${files}`,
    });
  }
  if (dependencies.has('mocha')) {
    commands.push({
      label: 'Mocha',
      detail: 'Run only the affected test files',
      command: `${exec} mocha ${files}`,
    });
  }
  if (markers.hasPytestConfig) {
    commands.push({
      label: 'pytest',
      detail: 'Run only the affected test files',
      command: `pytest ${files}`,
    });
  }
  if (markers.hasGoMod) {
    commands.push({
      label: 'go test',
      detail: 'Go tests run per package, so the affected packages are used',
      command: `go test ${packageDirs(testFiles).map(quote).join(' ')}`,
    });
  }
  if (markers.hasCargoToml) {
    commands.push({
      label: 'cargo test',
      detail: 'Cargo selects tests by name, so this runs the whole test target',
      command: 'cargo test',
    });
  }
  if (markers.hasGemfile) {
    commands.push({
      label: 'RSpec',
      detail: 'Run only the affected spec files',
      command: `bundle exec rspec ${files}`,
    });
  }
  if (markers.hasComposerJson) {
    commands.push({
      label: 'PHPUnit',
      detail: 'Run only the affected test files',
      command: `vendor/bin/phpunit ${files}`,
    });
  }
  if (markers.hasPomXml) {
    commands.push({
      label: 'Maven',
      detail: 'Maven selects by class name, so this runs the whole test phase',
      command: 'mvn test',
    });
  }
  if (markers.hasGradle) {
    commands.push({
      label: 'Gradle',
      detail: 'Gradle selects by class name, so this runs the whole test task',
      command: './gradlew test',
    });
  }
  if (markers.hasDotnetProject) {
    commands.push({
      label: 'dotnet test',
      detail: 'dotnet selects by filter expression, so this runs the whole suite',
      command: 'dotnet test',
    });
  }
  if (markers.nodeScripts.includes('test')) {
    commands.push({
      label: 'npm test script',
      detail: "The project's own test script, running the full suite",
      command:
        markers.packageManager === 'pnpm'
          ? 'pnpm test'
          : markers.packageManager === 'yarn'
            ? 'yarn test'
            : 'npm test',
    });
  }
  return commands;
}

export function detectProjectMarkers(root: string): ProjectMarkers {
  const packageJsonPath = join(root, 'package.json');
  let nodeDependencies: string[] = [];
  let nodeScripts: string[] = [];
  const hasPackageJson = existsSync(packageJsonPath);
  if (hasPackageJson) {
    try {
      const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        scripts?: Record<string, string>;
      };
      nodeDependencies = [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ];
      nodeScripts = Object.keys(parsed.scripts ?? {});
    } catch {
      // A malformed package.json just means no Node-based candidates.
    }
  }
  const has = (name: string) => existsSync(join(root, name));
  return {
    nodeDependencies,
    nodeScripts,
    packageManager: has('pnpm-lock.yaml')
      ? 'pnpm'
      : has('yarn.lock')
        ? 'yarn'
        : hasPackageJson
          ? 'npm'
          : undefined,
    hasPackageJson,
    hasPytestConfig:
      has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tox.ini'),
    hasGoMod: has('go.mod'),
    hasCargoToml: has('Cargo.toml'),
    hasPomXml: has('pom.xml'),
    hasGradle: has('build.gradle') || has('build.gradle.kts') || has('gradlew'),
    hasDotnetProject: has('global.json') || has('Directory.Build.props'),
    hasGemfile: has('Gemfile'),
    hasComposerJson: has('composer.json'),
  };
}

/**
 * Run the affected tests for a project.
 *
 * CodeBrain already does the hard part — working out *which* tests matter — but
 * stopping there leaves the developer copying paths into a terminal by hand,
 * which is where the loop usually breaks. The command is always shown for
 * confirmation before it runs, because running a project's test suite is a real
 * side effect and the detected runner may be wrong.
 */
export async function runAffectedTests(
  args: { root: string; tests: string[] } | undefined,
  fallback: () => { root: string; tests: string[] } | undefined,
): Promise<void> {
  const target = args?.tests?.length ? args : fallback();
  if (!target || target.tests.length === 0) {
    void vscode.window.showInformationMessage(
      'CodeBrain found no affected tests to run. Analyze change impact first, or check that your tests follow a recognised naming pattern.',
    );
    return;
  }

  const configured = vscode.workspace
    .getConfiguration('codebrain')
    .get<string>('tests.command', '')
    .trim();
  let command: string | undefined;

  if (configured) {
    // An explicitly configured template is a standing decision: honour it
    // without a second prompt.
    command = configured.includes('${files}')
      ? configured.replaceAll('${files}', fileList(target.tests))
      : `${configured} ${fileList(target.tests)}`;
  } else {
    const candidates = buildTestCommands(
      detectProjectMarkers(target.root),
      target.tests,
    );
    if (candidates.length === 0) {
      command = await vscode.window.showInputBox({
        title: 'CodeBrain: Run Affected Tests',
        prompt:
          'No test runner was detected. Enter the command to run, or set codebrain.tests.command.',
        value: fileList(target.tests),
        ignoreFocusOut: true,
      });
    } else {
      const picked = await vscode.window.showQuickPick(
        candidates.map((candidate) => ({
          label: candidate.label,
          description: candidate.detail,
          detail: candidate.command,
          command: candidate.command,
        })),
        {
          title: `CodeBrain: Run ${target.tests.length} affected test file(s)`,
          placeHolder: 'Choose how to run the affected tests',
          ignoreFocusOut: true,
        },
      );
      if (!picked) return;
      command = await vscode.window.showInputBox({
        title: 'CodeBrain: Run Affected Tests',
        prompt: 'Review the command before it runs',
        value: picked.command,
        ignoreFocusOut: true,
      });
    }
  }

  if (!command?.trim()) return;

  // Name the terminal after the project: reusing one by a shared name would run
  // the tests in whichever project happened to open it first.
  const name = `CodeBrain Tests · ${target.root.split(/[\\/]/).pop() ?? target.root}`;
  const terminal =
    vscode.window.terminals.find((item) => item.name === name) ??
    vscode.window.createTerminal({ name, cwd: target.root });
  terminal.show(true);
  terminal.sendText(command);
}
