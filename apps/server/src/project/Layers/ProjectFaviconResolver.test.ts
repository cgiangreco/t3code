import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ProjectFaviconResolver } from "../Services/ProjectFaviconResolver.ts";
import { ProjectFaviconResolverLive } from "./ProjectFaviconResolver.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-favicon-",
  });
});

const writeTextFile = Effect.fn("writeTextFile")(function* (
  cwd: string,
  relativePath: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const absolutePath = path.join(cwd, relativePath);
  yield* fileSystem
    .makeDirectory(path.dirname(absolutePath), { recursive: true })
    .pipe(Effect.orDie);
  yield* fileSystem.writeFileString(absolutePath, contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("ProjectFaviconResolverLive", (it) => {
  describe("resolvePath", () => {
    it.effect("prefers well-known favicon files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "favicon.svg", "<svg>favicon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("favicon.svg");
      }),
    );

    it.effect("resolves icon hrefs from project source files", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "index.html", '<link rel="icon" href="/brand/logo.svg">');
        yield* writeTextFile(cwd, "public/brand/logo.svg", "<svg>brand</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("public/brand/logo.svg");
      }),
    );

    it.effect("resolves root-level icon files when no favicon exists", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(cwd, "icon.svg", "<svg>icon</svg>");

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).not.toBeNull();
        expect(resolved).toContain("icon.svg");
      }),
    );

    it.effect("prefers explicit project files over generated fallback icons", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const tempDir = yield* makeTempDir;
        const path = yield* Path.Path;
        const cwd = path.join(tempDir, "sunwatcher");
        yield* writeTextFile(cwd, "logo.svg", "<svg>sunwatcher</svg>");

        const resolved = yield* resolver.resolve(cwd);

        expect(resolved?._tag).toBe("File");
        if (resolved?._tag === "File") {
          expect(resolved.path).toContain("logo.svg");
        }
      }),
    );

    it.effect("resolves generated icons for known projects", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const tempDir = yield* makeTempDir;
        const path = yield* Path.Path;
        const cwd = path.join(tempDir, "the-anonymous-coder");
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(cwd, { recursive: true }).pipe(Effect.orDie);

        const resolved = yield* resolver.resolve(cwd);

        expect(resolved?._tag).toBe("Svg");
        if (resolved?._tag === "Svg") {
          expect(resolved.svg).toContain("project-favicon-youtube");
        }
      }),
    );

    it.effect("resolves generated icons from package dependencies", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;
        yield* writeTextFile(
          cwd,
          "package.json",
          '{"dependencies":{"react":"latest"}}',
        );

        const resolved = yield* resolver.resolve(cwd);

        expect(resolved?._tag).toBe("Svg");
        if (resolved?._tag === "Svg") {
          expect(resolved.svg).toContain("project-favicon-react");
        }
      }),
    );

    it.effect("returns null when no icon is present", () =>
      Effect.gen(function* () {
        const resolver = yield* ProjectFaviconResolver;
        const cwd = yield* makeTempDir;

        const resolved = yield* resolver.resolvePath(cwd);

        expect(resolved).toBeNull();
      }),
    );
  });
});
