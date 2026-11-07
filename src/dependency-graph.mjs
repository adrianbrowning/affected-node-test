function dependencyPathsForTest(edges, test) {
  const adjacency = new Map();
  for (const [parent, child] of edges) {
    if (!adjacency.has(parent)) adjacency.set(parent, new Set());
    adjacency.get(parent).add(child);
  }
  const paths = new Map([[test, [test]]]);
  const queue = [test];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    for (const dependency of adjacency.get(parent) ?? []) {
      if (paths.has(dependency)) continue;
      paths.set(dependency, [...paths.get(parent), dependency]);
      queue.push(dependency);
    }
  }
  return paths;
}

export function dependenciesForTest(edges, test) {
  return new Set(dependencyPathsForTest(edges, test).keys());
}

export function dependencyPathForTest(edges, test, dependency) {
  return dependencyPathsForTest(edges, test).get(dependency);
}
