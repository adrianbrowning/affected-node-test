import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

function literalSpecifier(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
}

function importsIn(source, sourceType) {
  const ast = parse(source, {
    allowHashBang: true,
    ecmaVersion: 'latest',
    sourceType,
  });
  const imports = [];
  let unresolved = false;
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration' ||
        (node.type === 'ExportNamedDeclaration' && node.source)) {
      imports.push({ kind: 'import', specifier: node.source.value });
    } else if (node.type === 'ImportExpression') {
      const specifier = literalSpecifier(node.source);
      if (specifier === undefined) unresolved = true;
      else imports.push({ kind: 'import', specifier });
    } else if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' &&
        node.callee.name === 'require') {
      const specifier = node.arguments.length === 1 ? literalSpecifier(node.arguments[0]) : undefined;
      if (specifier === undefined) unresolved = true;
      else imports.push({ kind: 'require', specifier });
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value === 'object' && typeof value.type === 'string') visit(value);
    }
  };
  visit(ast);
  return { imports, unresolved };
}

function inside(root, path) {
  if (!isAbsolute(path)) return false;
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' ||
    (pathFromRoot !== '..' && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot));
}

function normalize(root, path) {
  return relative(root, path).split(sep).join('/');
}

function resolveSpecifier(parent, { kind, specifier }) {
  let resolved;
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

export function buildStaticGraph(root, test, roots) {
  const edges = [];
  const pending = [...roots];
  const visited = new Set();
  let unresolved = false;
  for (const rootFile of roots) {
    if (rootFile !== test) edges.push([test, rootFile]);
  }
  while (pending.length) {
    const repositoryPath = pending.pop();
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
