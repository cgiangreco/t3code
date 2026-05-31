import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  ProjectFaviconResolver,
  type ProjectFaviconResolution,
  type ProjectFaviconResolverShape,
} from "../Services/ProjectFaviconResolver.ts";

// Well-known favicon paths checked in order.
const FAVICON_CANDIDATES = [
  "logo.svg",
  "logo.ico",
  "logo.png",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "icon.svg",
  "icon.ico",
  "icon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  ".idea/icon.svg",
] as const;

const REACT_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-11.5 -10.23174 23 20.46348" data-fallback="project-favicon-react"><circle cx="0" cy="0" r="2.05" fill="#61dafb"/><g fill="none" stroke="#61dafb" stroke-width="1"><ellipse rx="11" ry="4.2"/><ellipse rx="11" ry="4.2" transform="rotate(60)"/><ellipse rx="11" ry="4.2" transform="rotate(120)"/></g></svg>`;
const ANDROID_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-android"><path fill="#3ddc84" d="M32 54h64v44c0 7.7-6.3 14-14 14H46c-7.7 0-14-6.3-14-14V54Z"/><path fill="#3ddc84" d="M39.5 48C42.8 34.2 52.2 26 64 26s21.2 8.2 24.5 22h-49Z"/><path stroke="#3ddc84" stroke-width="7" stroke-linecap="round" d="M46 24 36 8m46 16L92 8M22 62v31m84-31v31M49 112v10m30-10v10"/><circle cx="52" cy="40" r="4" fill="#173b2d"/><circle cx="76" cy="40" r="4" fill="#173b2d"/></svg>`;
const YOUTUBE_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-youtube"><rect x="10" y="28" width="108" height="72" rx="18" fill="#ff0033"/><path d="M55 48v32l29-16-29-16Z" fill="white"/></svg>`;
const T3_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" data-fallback="project-favicon-t3"><path d="M0 10C0 4.477 4.477 0 10 0h108c5.523 0 10 4.477 10 10v108c0 5.523-4.477 10-10 10H10c-5.523 0-10-4.477-10-10V10Z" fill="#000"/><path d="M33.451 93V47.56h-17.92V37h48.8v10.56h-17.92V93h-12.96Zm53.274.96c-3.893 0-7.76-.507-11.6-1.52-3.84-1.067-7.093-2.56-9.76-4.48l5.04-9.92c2.134 1.547 4.614 2.773 7.44 3.68 2.827.907 5.68 1.36 8.56 1.36 3.254 0 5.814-.64 7.68-1.92 1.867-1.28 2.8-3.04 2.8-5.28 0-2.133-.826-3.813-2.48-5.04-1.653-1.227-4.32-1.84-8-1.84h-5.92v-8.56l15.6-17.68 1.44 4.64h-29.36V37h39.2v8.4l-15.52 17.68-6.56-3.76h3.76c6.88 0 12.08 1.547 15.6 4.64 3.52 3.093 5.28 7.067 5.28 11.92 0 3.147-.826 6.107-2.48 8.88-1.653 2.72-4.186 4.933-7.6 6.64-3.413 1.707-7.786 2.56-13.12 2.56Z" fill="#fff"/></svg>`;

const FALLBACK_SVG_BY_PROJECT_NAME: Record<string, string> = {
  "newsletter-companion": ANDROID_ICON_SVG,
  "react-kofi-button-modern": REACT_ICON_SVG,
  "react-native-kofi-button-modern": REACT_ICON_SVG,
  sunwatcher: REACT_ICON_SVG,
  "the-anonymous-coder": YOUTUBE_ICON_SVG,
  "t3code-app": T3_ICON_SVG,
};

// Files that may contain a <link rel="icon"> or icon metadata declaration.
const ICON_SOURCE_FILES = [
  "index.html",
  "public/index.html",
  "app/routes/__root.tsx",
  "src/routes/__root.tsx",
  "app/root.tsx",
  "src/root.tsx",
  "src/index.html",
] as const;

// Matches <link ...> tags or object-like icon metadata where rel/href can appear in any order.
const LINK_ICON_HTML_RE =
  /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const LINK_ICON_OBJ_RE =
  /(?=[^}]*\brel\s*:\s*["'](?:icon|shortcut icon)["'])(?=[^}]*\bhref\s*:\s*["']([^"'?]+))[^}]*/i;

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);

function extractIconHref(source: string): string | null {
  const htmlMatch = source.match(LINK_ICON_HTML_RE);
  if (htmlMatch?.[1]) return htmlMatch[1];
  const objMatch = source.match(LINK_ICON_OBJ_RE);
  if (objMatch?.[1]) return objMatch[1];
  return null;
}

export const makeProjectFaviconResolver = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const resolveIconHref = (projectCwd: string, href: string): string[] => {
    const clean = href.replace(/^\//, "");
    return [path.join(projectCwd, "public", clean), path.join(projectCwd, clean)];
  };

  const isPathWithinProject = (projectCwd: string, candidatePath: string): boolean => {
    const relative = path.relative(path.resolve(projectCwd), path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  };

  const findExistingFile = Effect.fn("ProjectFaviconResolver.findExistingFile")(function* (
    projectCwd: string,
    candidates: ReadonlyArray<string>,
  ): Effect.fn.Return<string | null> {
    for (const candidate of candidates) {
      if (!isPathWithinProject(projectCwd, candidate)) {
        continue;
      }
      const stats = yield* fileSystem.stat(candidate).pipe(Effect.orElseSucceed(() => null));
      if (stats?.type === "File") {
        return candidate;
      }
    }
    return null;
  });

  const readPackageJson = Effect.fn("ProjectFaviconResolver.readPackageJson")(function* (
    projectCwd: string,
  ): Effect.fn.Return<Record<string, unknown> | null> {
    const source = yield* fileSystem
      .readFileString(path.join(projectCwd, "package.json"))
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!source) return null;

    const decoded = yield* decodeUnknownJsonString(source).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : null;
  });

  const resolveFallbackSvg = Effect.fn("ProjectFaviconResolver.resolveFallbackSvg")(function* (
    cwd: string,
  ): Effect.fn.Return<string | null> {
    const projectName = path.basename(path.resolve(cwd));
    const parentName = path.basename(path.dirname(path.resolve(cwd)));
    const knownProjectSvg =
      FALLBACK_SVG_BY_PROJECT_NAME[projectName] ?? FALLBACK_SVG_BY_PROJECT_NAME[parentName];
    if (knownProjectSvg) {
      return knownProjectSvg;
    }

    const packageJson = yield* readPackageJson(cwd);
    const packageName = typeof packageJson?.name === "string" ? packageJson.name : null;
    if (packageName === "@t3tools/monorepo" || packageName === "t3") {
      return T3_ICON_SVG;
    }

    const dependencyBlocks = ["dependencies", "devDependencies", "peerDependencies"] as const;
    const dependencies = new Set<string>();
    for (const blockName of dependencyBlocks) {
      const block = packageJson?.[blockName];
      if (block && typeof block === "object" && !Array.isArray(block)) {
        for (const dependencyName of Object.keys(block)) {
          dependencies.add(dependencyName);
        }
      }
    }

    if (dependencies.has("expo") || dependencies.has("react-native")) {
      return REACT_ICON_SVG;
    }
    if (dependencies.has("react") || dependencies.has("react-dom")) {
      return REACT_ICON_SVG;
    }

    return null;
  });

  const resolve: ProjectFaviconResolverShape["resolve"] = Effect.fn(
    "ProjectFaviconResolver.resolve",
  )(function* (cwd: string): Effect.fn.Return<ProjectFaviconResolution | null> {
    for (const candidate of FAVICON_CANDIDATES) {
      const resolved = path.join(cwd, candidate);
      const existing = yield* findExistingFile(cwd, [resolved]);
      if (existing) {
        return { _tag: "File", path: existing } satisfies ProjectFaviconResolution;
      }
    }

    for (const sourceFile of ICON_SOURCE_FILES) {
      const sourcePath = path.join(cwd, sourceFile);
      const source = yield* fileSystem
        .readFileString(sourcePath)
        .pipe(Effect.orElseSucceed(() => null));
      if (!source) {
        continue;
      }
      const href = extractIconHref(source);
      if (!href) {
        continue;
      }
      const existing = yield* findExistingFile(cwd, resolveIconHref(cwd, href));
      if (existing) {
        return { _tag: "File", path: existing } satisfies ProjectFaviconResolution;
      }
    }

    const fallbackSvg = yield* resolveFallbackSvg(cwd);
    if (fallbackSvg) {
      return { _tag: "Svg", svg: fallbackSvg } satisfies ProjectFaviconResolution;
    }

    return null;
  });

  const resolvePath: ProjectFaviconResolverShape["resolvePath"] = Effect.fn(
    "ProjectFaviconResolver.resolvePath",
  )(function* (cwd: string): Effect.fn.Return<string | null> {
    const resolution = yield* resolve(cwd);
    return resolution?._tag === "File" ? resolution.path : null;
  });

  return {
    resolve,
    resolvePath,
  } satisfies ProjectFaviconResolverShape;
});

export const ProjectFaviconResolverLive = Layer.effect(
  ProjectFaviconResolver,
  makeProjectFaviconResolver,
);
