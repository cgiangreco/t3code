import {
  type KimiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { isLoggedIn, parseConfig } from "@moonshot-ai/kimi-agent-sdk";

import {
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { enrichProviderSnapshotWithVersionAdvisory } from "../providerMaintenance.ts";
import type { ProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import { HttpClient } from "effect/unstable/http";

const KIMI_PRESENTATION = {
  displayName: "Kimi",
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
  requiresNewThreadForModelChange: true,
} as const;

const PROVIDER = ProviderDriverKind.make("kimi");

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

const KIMI_DEFAULT_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "kimi-code/kimi-for-coding",
    name: "Kimi for Coding",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
  {
    slug: "kimi-latest",
    name: "Kimi Latest",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function discoverKimiModelsFromConfig(): ReadonlyArray<ServerProviderModel> {
  try {
    const config = parseConfig();
    if (!config.models || config.models.length === 0) {
      return KIMI_DEFAULT_MODELS;
    }
    return config.models.map((model) => ({
      slug: model.id,
      name: model.name?.trim() || model.id,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    }));
  } catch {
    return KIMI_DEFAULT_MODELS;
  }
}

function kimiModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const builtIn = discoverKimiModelsFromConfig();
  return providerModelsFromSettings(builtIn, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialKimiProviderSnapshot(
  kimiSettings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = kimiModelsFromSettings(kimiSettings.customModels);

    if (!kimiSettings.enabled) {
      return buildServerProvider({
        presentation: KIMI_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Kimi is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Kimi availability...",
      },
    });
  });
}

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  kimiSettings: KimiSettings,
): Effect.fn.Return<ServerProviderDraft> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);

  if (!kimiSettings.enabled) {
    const models = kimiModelsFromSettings(kimiSettings.customModels);
    return buildServerProvider({
      presentation: KIMI_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Kimi is disabled in T3 Code settings.",
      },
    });
  }

  const models = yield* Effect.sync(() => kimiModelsFromSettings(kimiSettings.customModels));

  const authStatus = yield* Effect.sync(() => {
    try {
      const loggedIn = isLoggedIn();
      return loggedIn
        ? ({ status: "authenticated" } as const)
        : ({ status: "unauthenticated" } as const);
    } catch {
      return { status: "unknown" } as const;
    }
  });

  const status: Exclude<import("@t3tools/contracts").ServerProviderState, "disabled"> =
    authStatus.status === "authenticated" ? "ready" : "error";

  return buildServerProvider({
    presentation: KIMI_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version: null,
      status,
      auth: authStatus,
      ...(authStatus.status === "unauthenticated"
        ? {
            message:
              "Kimi is not authenticated. Run `kimi` and send `/login` to configure your API key, or set KIMI_API_KEY.",
          }
        : {}),
    },
  });
});

export const enrichKimiSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enriched) => input.publishSnapshot(enriched)),
    Effect.catchCause(() => Effect.void),
    Effect.asVoid,
  );
