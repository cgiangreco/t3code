/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type ProjectFaviconResolution =
  | {
      readonly _tag: "File";
      readonly path: string;
    }
  | {
      readonly _tag: "Svg";
      readonly svg: string;
    };

/**
 * ProjectFaviconResolverShape - Service API for project favicon lookup.
 */
export interface ProjectFaviconResolverShape {
  /**
   * Resolve a project favicon.
   *
   * Project files are preferred. If none exist, this may return a generated
   * tech-stack SVG for recognized projects.
   */
  readonly resolve: (cwd: string) => Effect.Effect<ProjectFaviconResolution | null>;

  /**
   * Resolve a favicon or icon file path for the provided workspace root.
   *
   * Returns `null` when no candidate icon file can be found. Generated fallback
   * SVGs are intentionally excluded from this compatibility helper.
   */
  readonly resolvePath: (cwd: string) => Effect.Effect<string | null>;
}

/**
 * ProjectFaviconResolver - Service tag for project favicon resolution.
 */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("t3/project/Services/ProjectFaviconResolver") {}
