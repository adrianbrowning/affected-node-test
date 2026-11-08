import { matchesPatterns, repositoryFileInventory } from './project-config.ts';
import type { ProjectConfig } from './project-config.ts';

export function discoverTestFiles(
  root: string,
  config: Pick<ProjectConfig, 'exclude' | 'include'>,
  inventory: string[] = repositoryFileInventory(root),
) {
  return inventory.filter((path) => {
    const included = config.include.length
      ? matchesPatterns(path, config.include)
      : /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(path);
    return included && !matchesPatterns(path, config.exclude);
  });
}
