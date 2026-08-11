import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';

const nodeRequire = createRequire(import.meta.url);
const SRC = fileURLToPath(new URL('../../src/', import.meta.url));

/**
 * Load a TypeScript module from `src/` for testing.
 *
 * Relative imports are compiled and loaded for real (recursively, with cycle
 * protection), so a module under test runs against its actual collaborators
 * rather than hand-written stand-ins that can drift from them. Only `vscode`
 * and anything explicitly listed in `stubs` is substituted.
 *
 * @param {string} relativePath Path to the entry module, relative to this file.
 * @param {Record<string, unknown>} stubs Modules to replace, keyed by specifier.
 */
export function loadTypeScript(relativePath, stubs = {}) {
  const cache = new Map();

  const loadFile = (absolutePath, chain) => {
    const key = absolutePath;
    if (cache.has(key)) return cache.get(key);
    if (chain.includes(key)) {
      // Break an import cycle with a placeholder; exports fill in as each
      // module finishes evaluating.
      return {};
    }
    const source = readFileSync(absolutePath, 'utf8');
    const compiled = ts.transpileModule(source, {
      compilerOptions: {
        esModuleInterop: true,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const module = { exports: {} };
    cache.set(key, module.exports);

    const localRequire = (name) => {
      if (name in stubs) return stubs[name];
      if (name === 'vscode') return stubs.vscode ?? {};
      if (name.startsWith('.')) {
        const target = resolve(dirname(absolutePath), `${name}.ts`);
        return loadFile(target, [...chain, key]);
      }
      return nodeRequire(name);
    };

    // Run in the current realm, the way Node's own CommonJS loader does.
    // `runInNewContext` would give the module a separate set of intrinsics, so
    // arrays and objects it returns would fail deepStrictEqual against ones
    // built here despite being structurally identical.
    const wrapper = vm.runInThisContext(
      `(function (exports, require, module, __filename, __dirname) {\n${compiled}\n})`,
      { filename: absolutePath },
    );
    wrapper(module.exports, localRequire, module, absolutePath, dirname(absolutePath));
    cache.set(key, module.exports);
    return module.exports;
  };

  return loadFile(resolve(SRC, relativePath.replace(/^.*\/src\//, '').replace(/^\.\//, '')), []);
}
