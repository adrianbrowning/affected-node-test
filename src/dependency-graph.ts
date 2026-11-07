export type DependencyEdge = [parent: string, child: string];

function dependencyPathsForTest(edges: DependencyEdge[], test: string) {
  const adjacency = new Map<string, Set<string>>();
  for (const [parent, child] of edges) {
    if (!adjacency.has(parent)) adjacency.set(parent, new Set());
    adjacency.get(parent)?.add(child);
  }
  const paths = new Map<string, string[]>([[test, [test]]]);
  const queue = [test];
  for (let index = 0; index < queue.length; index += 1) {
    const parent = queue[index];
    for (const dependency of adjacency.get(parent) ?? []) {
      if (paths.has(dependency)) continue;
      paths.set(dependency, [...(paths.get(parent) ?? []), dependency]);
      queue.push(dependency);
    }
  }
  return paths;
}

export function dependenciesForTest(edges: DependencyEdge[], test: string) {
  return new Set(dependencyPathsForTest(edges, test).keys());
}

export function dependencyPathForTest(edges: DependencyEdge[], test: string, dependency: string) {
  return dependencyPathsForTest(edges, test).get(dependency);
}
