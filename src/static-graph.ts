import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import type { DependencyEdge } from './dependency-graph.ts';

type AstNode = { type: string; [key: string]: unknown };
type StaticImport = { kind: 'import' | 'require'; specifier: string };

function isAstNode(value: unknown): value is AstNode {
  return Boolean(value) && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}

function literalSpecifier(value: unknown) {
  if (!isAstNode(value)) return;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'TemplateLiteral' && Array.isArray(value.expressions) && value.expressions.length === 0 &&
      Array.isArray(value.quasis)) {
    const first = value.quasis[0];
    if (isAstNode(first) && first.value && typeof first.value === 'object') {
      const cooked = (first.value as { cooked?: unknown }).cooked;
      if (typeof cooked === 'string') return cooked;
    }
  }
}

function importsIn(source: string, sourceType: 'commonjs' | 'module') {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    sourceType,
  });
  const imports: StaticImport[] = [];
  let unresolved = false;
  const visit = (node: AstNode) => {
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
        (node.type === 'ExportNamedDeclaration' && node.source)) {
      if (isAstNode(node.source) && typeof node.source.value === 'string') {
        imports.push({ kind: 'import', specifier: node.source.value });
      }
    } else if (node.type === 'ImportExpression') {
      const specifier = literalSpecifier(node.source);
      if (specifier === undefined) unresolved = true;
      else imports.push({ kind: 'import', specifier });
    } else if (node.type === 'CallExpression' && isAstNode(node.callee) && node.callee.type === 'Identifier' &&
        node.callee.name === 'require' && Array.isArray(node.arguments)) {
      const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : undefined;
      if (specifier === undefined) unresolved = true;
      else imports.push({ kind: 'require', specifier });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) if (isAstNode(child)) visit(child);
      } else if (isAstNode(value)) {
        visit(value);
      }
    }
  };
  visit(ast as unknown as AstNode);
  return { imports, unresolved };
}

function inside(root: string, path: string) {
  if (!isAbsolute(path)) return false;
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function normalize(root: string, path: string) {
  return relative(root, path).split(sep).join('/');
}

function resolveSpecifier(parent: string, { kind, specifier }: StaticImport) {
  let resolved: string;
  if (kind === 'import' && specifier.startsWith('file:')) resolved = specifier;
  else if (kind === 'import' && specifier.startsWith('.')) {
    resolved = new URL(specifier, pathToFileURL(parent)).href;
  } else if (kind === 'import' && isAbsolute(specifier)) {
    resolved = pathToFileURL(specifier).href;
  } else {
    resolved = createRequire(parent).resolve(specifier);
  }
  return resolved.startsWith('file:') ? fileURLToPath(resolved) : resolved;
}

export function buildStaticGraph(root: string, test: string, roots: string[]) {
  const edges: DependencyEdge[] = [];
  const pending = [...roots];
  const visited = new Set<string>();
  let unresolved = false;
  for (const rootFile of roots) {
    if (rootFile !== test) edges.push([test, rootFile]);
  }
  while (pending.length) {
    const repositoryPath = pending.pop();
    if (repositoryPath === undefined) break;
    if (visited.has(repositoryPath)) continue;
    visited.add(repositoryPath);
    if (!/\.(?:[cm]?[jt]s|[jt]sx)$/.test(repositoryPath)) continue;
    const absolutePath = new URL(repositoryPath, `${pathToFileURL(root).href}/`);
    let parsed;
    try {
      const sourceType = /\.c[jt]s$/.test(repositoryPath) ? 'commonjs' : 'module';
      parsed = importsIn(readFileSync(absolutePath, 'utf8'), sourceType);
    } catch {
      unresolved = true;
      continue;
    }
    if (parsed.unresolved) unresolved = true;
    for (const imported of parsed.imports) {
      let resolved;
      try {
        resolved = resolveSpecifier(fileURLToPath(absolutePath), imported);
      } catch {
        unresolved = true;
        continue;
      }
      if (!inside(root, resolved)) continue;
      const child = normalize(root, resolved);
      if (child.startsWith('node_modules/') || child.startsWith('.git/') ||
          child.startsWith('.affected-tests/')) continue;
      edges.push([repositoryPath, child]);
      pending.push(child);
    }
  }
  const uniqueEdges = [...new Map(edges.map((edge) => [JSON.stringify(edge), edge])).values()];
  return { edges: uniqueEdges, unresolved };
}
