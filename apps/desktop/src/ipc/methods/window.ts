import {
  ContextMenuItemSchema,
  DesktopAppBrandingSchema,
  DesktopEnvironmentBootstrapSchema,
  DesktopProjectFaviconFetchInputSchema,
  DesktopProjectFaviconFetchResultSchema,
  DesktopThemeSchema,
  PickFolderOptionsSchema,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopBackendManager from "../../backend/DesktopBackendManager.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ElectronMenu from "../../electron/ElectronMenu.ts";
import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as ElectronTheme from "../../electron/ElectronTheme.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod, makeSyncIpcMethod } from "../DesktopIpc.ts";

const ContextMenuPosition = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});

const ContextMenuInput = Schema.Struct({
  items: Schema.Array(ContextMenuItemSchema),
  position: Schema.optionalKey(ContextMenuPosition),
});

function toWebSocketBaseUrl(httpBaseUrl: URL): string {
  const url = new URL(httpBaseUrl.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

class DesktopProjectFaviconFetchError extends Data.TaggedError("DesktopProjectFaviconFetchError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.reason;
  }
}

function validateProjectFaviconUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.pathname !== "/api/project-favicon"
  ) {
    throw new DesktopProjectFaviconFetchError({
      reason: "Desktop project favicon fetch is restricted to HTTP(S) project favicon URLs.",
    });
  }
  return url;
}

export const getAppBranding = makeSyncIpcMethod({
  channel: IpcChannels.GET_APP_BRANDING_CHANNEL,
  result: Schema.NullOr(DesktopAppBrandingSchema),
  handler: Effect.fn("desktop.ipc.window.getAppBranding")(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    return environment.branding;
  }),
});

export const getLocalEnvironmentBootstrap = makeSyncIpcMethod({
  channel: IpcChannels.GET_LOCAL_ENVIRONMENT_BOOTSTRAP_CHANNEL,
  result: Schema.NullOr(DesktopEnvironmentBootstrapSchema),
  handler: Effect.fn("desktop.ipc.window.getLocalEnvironmentBootstrap")(function* () {
    const backendManager = yield* DesktopBackendManager.DesktopBackendManager;
    const config = yield* backendManager.currentConfig;
    return Option.match(config, {
      onNone: () => null,
      onSome: ({ bootstrap, httpBaseUrl }) => ({
        label: "Local environment",
        httpBaseUrl: httpBaseUrl.href,
        wsBaseUrl: toWebSocketBaseUrl(httpBaseUrl),
        ...(bootstrap.desktopBootstrapToken
          ? { bootstrapToken: bootstrap.desktopBootstrapToken }
          : {}),
      }),
    });
  }),
});

export const pickFolder = makeIpcMethod({
  channel: IpcChannels.PICK_FOLDER_CHANNEL,
  payload: Schema.UndefinedOr(PickFolderOptionsSchema),
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.pickFolder")(function* (options) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const selectedPath = yield* dialog.pickFolder({
      owner: yield* electronWindow.focusedMainOrFirst,
      defaultPath: environment.resolvePickFolderDefaultPath(options),
    });
    return Option.getOrNull(selectedPath);
  }),
});

export const confirm = makeIpcMethod({
  channel: IpcChannels.CONFIRM_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.confirm")(function* (message) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    return yield* electronWindow.focusedMainOrFirst.pipe(
      Effect.flatMap((owner) => dialog.confirm({ owner, message })),
    );
  }),
});

export const setTheme = makeIpcMethod({
  channel: IpcChannels.SET_THEME_CHANNEL,
  payload: DesktopThemeSchema,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.window.setTheme")(function* (theme) {
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    yield* electronTheme.setSource(theme);
  }),
});

export const showContextMenu = makeIpcMethod({
  channel: IpcChannels.CONTEXT_MENU_CHANNEL,
  payload: ContextMenuInput,
  result: Schema.NullOr(Schema.String),
  handler: Effect.fn("desktop.ipc.window.showContextMenu")(function* (input) {
    const electronMenu = yield* ElectronMenu.ElectronMenu;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const window = yield* electronWindow.focusedMainOrFirst;
    if (Option.isNone(window)) {
      return null;
    }

    const selectedItemId = yield* electronMenu.showContextMenu({
      window: window.value,
      items: input.items,
      position: Option.fromNullishOr(input.position),
    });
    return Option.getOrNull(selectedItemId);
  }),
});

export const openExternal = makeIpcMethod({
  channel: IpcChannels.OPEN_EXTERNAL_CHANNEL,
  payload: Schema.String,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.window.openExternal")(function* (url) {
    const shell = yield* ElectronShell.ElectronShell;
    return yield* shell.openExternal(url);
  }),
});

export const fetchProjectFavicon = makeIpcMethod({
  channel: IpcChannels.FETCH_PROJECT_FAVICON_CHANNEL,
  payload: DesktopProjectFaviconFetchInputSchema,
  result: DesktopProjectFaviconFetchResultSchema,
  handler: Effect.fn("desktop.ipc.window.fetchProjectFavicon")(function* (input) {
    yield* Effect.logInfo("desktop project favicon fetch requested", { url: input.url });
    const url = yield* Effect.try({
      try: () => validateProjectFaviconUrl(input.url),
      catch: (cause) =>
        cause instanceof DesktopProjectFaviconFetchError
          ? cause
          : new DesktopProjectFaviconFetchError({
              reason: "Desktop project favicon fetch received an invalid URL.",
              cause,
            }),
    });

    const fetchImpl = yield* Effect.promise(async () => {
      const electron = (await import("electron")) as {
        readonly net?: { readonly fetch?: typeof globalThis.fetch };
      };
      return electron.net?.fetch?.bind(electron.net) ?? globalThis.fetch;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopProjectFaviconFetchError({
            reason: "Desktop project favicon fetch could not resolve a fetch implementation.",
            cause,
          }),
      ),
    );

    const response = yield* Effect.tryPromise({
      try: () => fetchImpl(url.toString()),
      catch: (cause) =>
        new DesktopProjectFaviconFetchError({
          reason: "Desktop project favicon fetch failed to execute.",
          cause,
        }),
    });
    if (!response.ok) {
      yield* Effect.logWarning("desktop project favicon fetch returned non-ok status", {
        url: url.toString(),
        status: response.status,
      });
      return null;
    }

    const bytes = yield* Effect.tryPromise({
      try: () => response.arrayBuffer(),
      catch: (cause) =>
        new DesktopProjectFaviconFetchError({
          reason: "Desktop project favicon response could not be read.",
          cause,
        }),
    });
    const contentType = response.headers.get("content-type")?.split(";")[0] ?? "image/svg+xml";
    yield* Effect.logInfo("desktop project favicon fetch succeeded", {
      url: url.toString(),
      status: response.status,
      contentType,
    });
    return `data:${contentType};base64,${Buffer.from(bytes).toString("base64")}`;
  }),
});
