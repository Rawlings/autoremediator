export { analyzeDependencies } from "./analyze.js";
export { removeUnusedDependencies } from "./apply.js";
export type {
  AnalyzeDependenciesOptions,
  AttackSurface,
  DependencyDietReport,
  DietApplyResult,
  DietApplyStatus,
  DependencySection,
  DietPackageReport,
  DuplicatePackage,
  DuplicatesReport,
  DuplicateVerdict,
  RemovedDependency,
  RemoveUnusedDependenciesOptions,
  ReplaceableDependency,
  ReplaceableStatus,
  SurfaceComponent,
  UnusedClassification,
  UnusedDependency,
} from "./types.js";
