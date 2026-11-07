export function dependenciesForTest(edges, test) {
  const adjacency = new Map();
  for (const [parent, child] of edges) {
    if (!adjacency.has(parent)) adjacency.set(parent, new Set());
    adjacency.get(parent).add(child);
  }
  const visited = new Set([test]);
  const stack = [test];
  while (stack.length) {
    for (const dependency of adjacency.get(stack.pop()) ?? []) {
      if (visited.has(dependency)) continue;
      visited.add(dependency);
      stack.push(dependency);
    }
  }
  return visited;
}
