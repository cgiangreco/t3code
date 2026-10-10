import {
  createSession as sdkCreateSession,
  type Session,
  type Turn,
  type StreamEvent,
  type ApprovalResponse,
} from "@moonshot-ai/kimi-agent-sdk";
import {
  ApprovalRequestId,
  type CanonicalItemType,
  type CanonicalRequestType,
  EventId,
  type KimiSettings,
  type ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeTurnStatus,
  type ProviderSession,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  type RuntimeContentStreamKind,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type UserInputQuestion,
  type RuntimeMode,
} from "@t3tools/contracts";
import { trimOrNull } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("kimi");
const PROVIDER_STR = "kimi";

const decodeJsonArgs = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

type KimiTextStreamKind = Extract<RuntimeContentStreamKind, "assistant_text" | "reasoning_text">;

type KimiContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "think"; readonly think: string }
  | { readonly type: "image_url"; readonly image_url: { readonly url: string } }
  | { readonly type: string };

interface KimiTurnState {
  readonly turnId: TurnId;
  readonly startedAt: string;
  nextSyntheticItemIndex: number;
}

interface PendingApproval {
  readonly requestType: CanonicalRequestType;
  readonly detail?: string;
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface ToolInFlight {
  readonly itemId: string;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail?: string;
  readonly input: Record<string, unknown>;
}

interface KimiSessionContext {
  session: ProviderSession;
  readonly sdkSession: Session;
  streamFiber: Fiber.Fiber<void, Error> | undefined;
  readonly startedAt: string;
  currentTurn: Turn | undefined;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly pendingUserInputs: Map<
    ApprovalRequestId,
    { readonly answers: Deferred.Deferred<ProviderUserInputAnswers> }
  >;
  readonly inFlightTools: Map<string, ToolInFlight>;
  turnState: KimiTurnState | undefined;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  stopped: boolean;
  pendingPlanMode: boolean | undefined;
  planModeActive: boolean;
}

export interface KimiAdapterOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

export type KimiAdapterShape = ProviderAdapterShape<ProviderAdapterError>;

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  return fallback;
}

function normalizeKimiStreamMessages(cause: Cause.Cause<unknown>): ReadonlyArray<string> {
  const errors = Cause.prettyErrors(cause)
    .map((error) => error.message.trim())
    .filter((message) => message.length > 0);
  if (errors.length > 0) {
    return errors;
  }
  const squashed = toMessage(Cause.squash(cause), "").trim();
  return squashed.length > 0 ? [squashed] : [];
}

function isKimiInterruptedMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("interrupted") ||
    normalized.includes("cancelled") ||
    normalized.includes("aborted")
  );
}

function isKimiInterruptedCause(cause: Cause.Cause<unknown>): boolean {
  return (
    Cause.hasInterruptsOnly(cause) ||
    normalizeKimiStreamMessages(cause).some(isKimiInterruptedMessage)
  );
}

function messageFromKimiStreamCause(cause: Cause.Cause<unknown>, fallback: string): string {
  return normalizeKimiStreamMessages(cause)[0] ?? fallback;
}

function interruptionMessageFromKimiCause(cause: Cause.Cause<unknown>): string {
  const message = messageFromKimiStreamCause(cause, "Kimi runtime interrupted.");
  return isKimiInterruptedMessage(message) ? "Kimi runtime interrupted." : message;
}

function asRuntimeRequestId(value: string): RuntimeRequestId {
  return RuntimeRequestId.make(value);
}

function nextSyntheticItemId(context: {
  turnState?: { nextSyntheticItemIndex: number } | undefined;
}): string {
  const index = context.turnState?.nextSyntheticItemIndex ?? 0;
  if (context.turnState) {
    context.turnState.nextSyntheticItemIndex = index + 1;
  }
  return `kimi-item-${index}`;
}

function classifyToolItemType(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  if (normalized.includes("subagent") || normalized.includes("sub-agent")) {
    return "collab_agent_tool_call";
  }
  return "dynamic_tool_call";
}

function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }
  const serialized = JSON.stringify(input);
  if (serialized === "{}") {
    return toolName;
  }
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

function streamKindFromContentPart(part: KimiContentPart): KimiTextStreamKind {
  if (part.type === "think") {
    return "reasoning_text";
  }
  return "assistant_text";
}

function textFromContentPart(part: KimiContentPart): string {
  if (part.type === "text") {
    return (part as { type: "text"; text: string }).text;
  }
  if (part.type === "think") {
    return (part as { type: "think"; think: string }).think;
  }
  return "";
}

function toSessionError(
  threadId: ThreadId,
  cause: unknown,
): ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError | undefined {
  const normalized = toMessage(cause, "").toLowerCase();
  if (normalized.includes("unknown session") || normalized.includes("not found")) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER_STR,
      threadId,
      cause,
    });
  }
  if (normalized.includes("closed")) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER_STR,
      threadId,
      cause,
    });
  }
  return undefined;
}

function toRequestError(threadId: ThreadId, method: string, cause: unknown): ProviderAdapterError {
  const sessionError = toSessionError(threadId, cause);
  if (sessionError) {
    return sessionError;
  }
  return new ProviderAdapterRequestError({
    provider: PROVIDER_STR,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function normalizeKimiTokenUsage(
  tokenUsage:
    | {
        input_other?: number;
        output?: number;
        input_cache_read?: number;
        input_cache_creation?: number;
      }
    | undefined,
): ThreadTokenUsageSnapshot | undefined {
  if (!tokenUsage) return undefined;
  const inputTokens =
    (typeof tokenUsage.input_other === "number" && Number.isFinite(tokenUsage.input_other)
      ? tokenUsage.input_other
      : 0) +
    (typeof tokenUsage.input_cache_read === "number" && Number.isFinite(tokenUsage.input_cache_read)
      ? tokenUsage.input_cache_read
      : 0) +
    (typeof tokenUsage.input_cache_creation === "number" &&
    Number.isFinite(tokenUsage.input_cache_creation)
      ? tokenUsage.input_cache_creation
      : 0);
  const outputTokens =
    typeof tokenUsage.output === "number" && Number.isFinite(tokenUsage.output)
      ? tokenUsage.output
      : 0;
  const totalProcessedTokens = inputTokens + outputTokens;
  if (totalProcessedTokens <= 0) {
    return undefined;
  }
  return {
    usedTokens: totalProcessedTokens,
    lastUsedTokens: totalProcessedTokens,
    ...(inputTokens > 0 ? { inputTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
  };
}

function mapKimiRuntimeMode(runtimeMode: RuntimeMode): boolean {
  switch (runtimeMode) {
    case "full-access":
      return true;
    case "auto":
    case "auto-accept-edits":
    case "approval-required":
      return false;
  }
}

function approvalResponseFromDecision(decision: ProviderApprovalDecision): ApprovalResponse {
  switch (decision) {
    case "acceptForSession":
      return "approve_for_session";
    case "accept":
      return "approve";
    case "decline":
    case "cancel":
    default:
      return "reject";
  }
}

export const makeKimiAdapter = Effect.fn("makeKimiAdapter")(function* (
  kimiSettings: KimiSettings,
  options: KimiAdapterOptions = {},
) {
  const nativeEventLogger =
    options.nativeEventLogger ??
    (options.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
      : undefined);

  const sessions = new Map<ThreadId, KimiSessionContext>();
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomUUIDv4 = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER_STR,
          method: "crypto/randomUUIDv4",
          detail: "Failed to generate Kimi runtime identifier.",
          cause,
        }),
    ),
  );
  const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
  const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

  const offerRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid);

  const logNativeEvent = Effect.fn("logNativeEvent")(function* (
    context: KimiSessionContext,
    event: StreamEvent,
  ) {
    if (!nativeEventLogger) return;
    const observedAt = yield* nowIso;
    const eventType = "type" in event ? (event as { type: string }).type : "unknown";
    const eventId = yield* randomUUIDv4;
    yield* nativeEventLogger.write(
      {
        observedAt,
        event: {
          id: eventId,
          kind: "notification",
          provider: PROVIDER_STR,
          createdAt: observedAt,
          method: `kimi/${eventType}`,
          ...(context.session.threadId ? { providerThreadId: context.session.threadId } : {}),
          ...(context.turnState ? { turnId: context.turnState.turnId } : {}),
          payload: event,
        },
      },
      context.session.threadId,
    );
  });

  const snapshotThread = Effect.fn("snapshotThread")(function* (context: KimiSessionContext) {
    const threadId = context.session.threadId;
    if (!threadId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER_STR,
        operation: "readThread",
        issue: "Session thread id is not initialized yet.",
      });
    }
    return { threadId, turns: [] };
  });

  const emitSessionStarted = (context: KimiSessionContext) =>
    Effect.gen(function* () {
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.started",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        payload: {},
        providerRefs: {},
      });
    });

  const emitSessionState = (context: KimiSessionContext, status: ProviderSession["status"]) =>
    Effect.gen(function* () {
      const { eventId, createdAt } = yield* makeEventStamp();
      context.session = { ...context.session, status, updatedAt: createdAt };
      const state =
        status === "ready"
          ? "ready"
          : status === "running"
            ? "running"
            : status === "connecting"
              ? "starting"
              : status === "error"
                ? "error"
                : "stopped";
      yield* offerRuntimeEvent({
        type: "session.state.changed",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        payload: { state },
        providerRefs: {},
      });
    });

  const emitTurnStarted = (context: KimiSessionContext, turnId: TurnId) =>
    Effect.gen(function* () {
      const { eventId, createdAt } = yield* makeEventStamp();
      context.turnState = { turnId, startedAt: createdAt, nextSyntheticItemIndex: 0 };
      context.session = {
        ...context.session,
        activeTurnId: turnId,
        status: "running",
        updatedAt: createdAt,
      };
      yield* offerRuntimeEvent({
        type: "turn.started",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        turnId,
        payload: {},
        providerRefs: {},
      });
    });

  const emitTurnCompleted = (context: KimiSessionContext, status: ProviderRuntimeTurnStatus) =>
    Effect.gen(function* () {
      if (!context.turnState) return;
      const { eventId, createdAt } = yield* makeEventStamp();
      const turnId = context.turnState.turnId;
      context.turnState = undefined;
      context.session = {
        ...context.session,
        activeTurnId: undefined,
        status: "ready",
        updatedAt: createdAt,
      };
      if (status === "interrupted" || status === "cancelled") {
        yield* offerRuntimeEvent({
          type: "turn.aborted",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: { reason: interruptionMessageFromKimiCause(Cause.empty) },
          providerRefs: {},
        });
      } else {
        yield* offerRuntimeEvent({
          type: "turn.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId: context.session.threadId,
          turnId,
          payload: { state: status },
          providerRefs: {},
        });
      }
    });

  const handleStreamEvent = Effect.fn("handleStreamEvent")(function* (
    context: KimiSessionContext,
    event: StreamEvent,
  ) {
    yield* logNativeEvent(context, event);

    if ("code" in event && "message" in event) {
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "runtime.error",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId: context.session.threadId,
        turnId: context.turnState?.turnId,
        payload: { message: (event as { message: string }).message },
        providerRefs: {},
      });
      return;
    }

    const threadId = context.session.threadId;
    const turnId = context.turnState?.turnId;

    const typedEvent = event as { type: string; payload?: unknown };

    switch (typedEvent.type) {
      case "TurnBegin": {
        if (turnId) yield* emitTurnCompleted(context, "completed");
        const newTurnId = TurnId.make(yield* randomUUIDv4);
        yield* emitTurnStarted(context, newTurnId);
        if (context.pendingPlanMode !== undefined) {
          const targetPlanMode = context.pendingPlanMode;
          context.planModeActive = targetPlanMode;
          context.pendingPlanMode = undefined;
          if (context.sdkSession.planMode !== targetPlanMode) {
            yield* Effect.tryPromise({
              try: () => (context.sdkSession as unknown as { setPlanMode(m: boolean): Promise<void> }).setPlanMode(targetPlanMode),
              catch: (cause) => toRequestError(context.session.threadId, "turn/setPlanMode", cause),
            }).pipe(Effect.ignore);
          }
        }
        break;
      }

      case "ContentPart": {
        if (!turnId) break;
        const part = typedEvent.payload as KimiContentPart;
        const { eventId, createdAt } = yield* makeEventStamp();
        const text = textFromContentPart(part);
        if (text.length > 0) {
          yield* offerRuntimeEvent({
            type: "content.delta",
            eventId,
            provider: PROVIDER,
            createdAt,
            threadId,
            turnId,
            payload: { streamKind: streamKindFromContentPart(part), delta: text },
            providerRefs: {},
          });
          if (context.planModeActive && part.type === "text") {
            yield* offerRuntimeEvent({
              type: "turn.proposed.delta",
              eventId: EventId.make(`${eventId}-plan`),
              provider: PROVIDER,
              createdAt,
              threadId,
              turnId,
              payload: { delta: text },
              providerRefs: {},
            });
          }
        }
        break;
      }

      case "StepBegin": {
        if (!turnId) break;
        const step = typedEvent.payload as { n: number };
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "task.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          payload: { taskId: RuntimeTaskId.make(`step-${step.n}`) },
          providerRefs: {},
        });
        break;
      }

      case "StepInterrupted": {
        if (!turnId) break;
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "turn.aborted",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          payload: { reason: "interrupted" },
          providerRefs: {},
        });
        break;
      }

      case "ToolCall": {
        if (!turnId) break;
        const toolCall = typedEvent.payload as {
          id: string;
          function: { name: string; arguments?: string };
        };
        const toolName = toolCall.function.name;
        const itemType = classifyToolItemType(toolName);
        const itemId = nextSyntheticItemId(context);
        const parsedArgs = decodeJsonArgs(toolCall.function.arguments ?? "{}");
        const input: Record<string, unknown> =
          Exit.isSuccess(parsedArgs) &&
          typeof parsedArgs.value === "object" &&
          parsedArgs.value !== null
            ? (parsedArgs.value as Record<string, unknown>)
            : ({ raw: toolCall.function.arguments } as Record<string, unknown>);
        const title = titleForTool(itemType);
        const detail = summarizeToolRequest(toolName, input);
        context.inFlightTools.set(toolCall.id, { itemId, itemType, toolName, title, detail, input });
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: { itemType, title, detail, data: { toolName, input } },
          providerRefs: { providerItemId: ProviderItemId.make(toolCall.id) },
        });
        break;
      }

      case "ToolResult": {
        if (!turnId) break;
        const toolResult = typedEvent.payload as {
          tool_call_id: string;
          return_value: { is_error?: boolean; display?: unknown; output?: unknown; message?: unknown };
        };
        const inFlight = context.inFlightTools.get(toolResult.tool_call_id);
        if (inFlight) context.inFlightTools.delete(toolResult.tool_call_id);
        const itemId = inFlight?.itemId ?? nextSyntheticItemId(context);
        const itemType = inFlight?.itemType ?? "dynamic_tool_call";
        const rv = toolResult.return_value;
        const displayBlocks: unknown[] = Array.isArray(rv.display) ? rv.display : [];
        const outputText = typeof rv.output === "string" ? rv.output : undefined;
        const messageText = typeof rv.message === "string" ? rv.message : undefined;
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: {
            itemType,
            status: rv.is_error ? "failed" : "completed",
            title: inFlight?.title ?? titleForTool(itemType),
            detail: inFlight?.detail,
            data: {
              toolName: inFlight?.toolName ?? itemType,
              input: inFlight?.input ?? {},
              ...(displayBlocks.length > 0 ? { display: displayBlocks } : {}),
              ...(outputText ? { output: outputText } : {}),
              ...(messageText ? { message: messageText } : {}),
            },
          },
          providerRefs: { providerItemId: ProviderItemId.make(toolResult.tool_call_id) },
        });
        break;
      }

      case "ApprovalRequest": {
        if (!turnId) break;
        const req = typedEvent.payload as { id: string; sender: string; description?: string };
        const requestId = ApprovalRequestId.make(req.id);
        const requestType = classifyRequestType(req.sender);
        const pending: PendingApproval = {
          requestType,
          ...(req.description !== undefined ? { detail: req.description } : {}),
          decision: yield* Deferred.make<ProviderApprovalDecision>(),
        };
        context.pendingApprovals.set(requestId, pending);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "request.opened",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          requestId: asRuntimeRequestId(req.id),
          payload: { requestType, detail: req.description },
          providerRefs: {},
        });
        break;
      }

      case "QuestionRequest": {
        if (!turnId) break;
        const qReq = typedEvent.payload as {
          id: string;
          questions: Array<{
            question: string;
            header?: string;
            options?: Array<{ label: string; description?: string }>;
            multi_select?: boolean;
          }>;
        };
        if (context.planModeActive) {
          const { eventId: planEventId, createdAt: planCreatedAt } = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "turn.proposed.completed",
            eventId: planEventId,
            provider: PROVIDER,
            createdAt: planCreatedAt,
            threadId,
            turnId,
            payload: { planMarkdown: "" },
            providerRefs: {},
          });
        }
        const requestId = ApprovalRequestId.make(qReq.id);
        const questions: Array<UserInputQuestion> = qReq.questions.map((q) => ({
          id: q.question,
          question: q.question,
          header: q.header ?? "Question",
          options: q.options?.map((o) => ({ label: o.label, description: o.description ?? "" })) ?? [],
          multiSelect: q.multi_select ?? false,
        }));
        const pending = { answers: yield* Deferred.make<ProviderUserInputAnswers>() };
        context.pendingUserInputs.set(requestId, pending);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "user-input.requested",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          requestId: asRuntimeRequestId(qReq.id),
          payload: { questions },
          providerRefs: {},
        });
        break;
      }

      case "StatusUpdate": {
        if (!turnId) break;
        const statusUpdate = typedEvent.payload as {
          plan_mode?: boolean;
          token_usage?: {
            input_other?: number;
            output?: number;
            input_cache_read?: number;
            input_cache_creation?: number;
          };
        };
        if (typeof statusUpdate.plan_mode === "boolean") {
          context.planModeActive = statusUpdate.plan_mode;
        }
        const tokenUsage = normalizeKimiTokenUsage(statusUpdate.token_usage);
        if (tokenUsage) {
          context.lastKnownTokenUsage = tokenUsage;
          const { eventId, createdAt } = yield* makeEventStamp();
          yield* offerRuntimeEvent({
            type: "thread.token-usage.updated",
            eventId,
            provider: PROVIDER,
            createdAt,
            threadId,
            turnId,
            payload: { usage: tokenUsage },
            providerRefs: {},
          });
        }
        break;
      }

      case "CompactionBegin": {
        if (!turnId) break;
        const itemId = nextSyntheticItemId(context);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: { itemType: "context_compaction", title: "Context compaction" },
          providerRefs: {},
        });
        break;
      }

      case "CompactionEnd": {
        if (!turnId) break;
        const itemId = nextSyntheticItemId(context);
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.completed",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(itemId),
          payload: { itemType: "context_compaction", title: "Context compaction" },
          providerRefs: {},
        });
        break;
      }

      case "SubagentEvent": {
        if (!turnId) break;
        const subEvent = typedEvent.payload as { parent_tool_call_id: string };
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "item.started",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId,
          turnId,
          itemId: RuntimeItemId.make(nextSyntheticItemId(context)),
          payload: {
            itemType: "collab_agent_tool_call",
            title: "Subagent task",
            detail: `Subagent ${subEvent.parent_tool_call_id}`,
          },
          providerRefs: {},
        });
        break;
      }

      default:
        break;
    }
  });

  const runTurnStream = Effect.fn("runTurnStream")(function* (
    context: KimiSessionContext,
    turn: Turn,
  ) {
    context.currentTurn = turn;

    const streamProgram = Stream.fromAsyncIterable(turn, (cause) =>
      toRequestError(context.session.threadId, "turn/stream", cause),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((event) => handleStreamEvent(context, event)),
    );

    const resultPromise = Effect.tryPromise({
      try: () => turn.result,
      catch: (cause) => toRequestError(context.session.threadId, "turn/result", cause),
    });

    const combined = Effect.all([streamProgram, resultPromise], { concurrency: 2 });
    const exit = yield* Effect.exit(combined);

    if (Exit.isSuccess(exit)) {
      const result = exit.value[1] as { status: string };
      if (result.status === "cancelled") {
        yield* emitTurnCompleted(context, "interrupted");
      } else {
        yield* emitTurnCompleted(context, "completed");
      }
    } else {
      const cause = exit.cause;
      if (isKimiInterruptedCause(cause)) {
        yield* emitTurnCompleted(context, "interrupted");
      } else {
        const message = messageFromKimiStreamCause(cause, "Kimi turn stream failed");
        yield* emitTurnCompleted(context, "failed");
        const { eventId, createdAt } = yield* makeEventStamp();
        yield* offerRuntimeEvent({
          type: "runtime.error",
          eventId,
          provider: PROVIDER,
          createdAt,
          threadId: context.session.threadId,
          turnId: context.turnState?.turnId,
          payload: { message },
          providerRefs: {},
        });
      }
    }

    context.currentTurn = undefined;
  });

  const requireContext = (threadId: ThreadId, _method: string) =>
    Effect.gen(function* () {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({
          provider: PROVIDER_STR,
          threadId,
        });
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER_STR,
          threadId,
        });
      }
      return context;
    });

  const startSession: KimiAdapterShape["startSession"] = (input) =>
    Effect.gen(function* () {
      const resolvedModel = input.modelSelection?.model ?? "kimi-code/kimi-for-coding";
      const threadId = input.threadId;
      const createdAt = yield* Effect.map(DateTime.now, DateTime.formatIso);

      const sdkSession = sdkCreateSession({
        workDir: input.cwd ?? process.cwd(),
        ...(input.resumeCursor ? { sessionId: String(input.resumeCursor) } : {}),
        model: resolvedModel,
        yoloMode: mapKimiRuntimeMode(input.runtimeMode ?? "full-access"),
        ...(kimiSettings.binaryPath ? { executable: kimiSettings.binaryPath } : {}),
      });

      const session: ProviderSession = {
        provider: PROVIDER,
        status: "connecting",
        runtimeMode: input.runtimeMode ?? "full-access",
        cwd: input.cwd,
        model: resolvedModel,
        threadId,
        resumeCursor: sdkSession.sessionId,
        activeTurnId: undefined,
        createdAt,
        updatedAt: createdAt,
        lastError: undefined,
      };

      const context: KimiSessionContext = {
        session,
        sdkSession,
        streamFiber: undefined,
        startedAt: createdAt,
        currentTurn: undefined,
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        inFlightTools: new Map(),
        turnState: undefined,
        lastKnownTokenUsage: undefined,
        stopped: false,
        pendingPlanMode: undefined,
        planModeActive: false,
      };

      sessions.set(threadId, context);
      yield* emitSessionStarted(context);
      yield* emitSessionState(context, "ready");
      return session;
    });

  const sendTurn: KimiAdapterShape["sendTurn"] = (input) =>
    Effect.gen(function* () {
      const context = yield* requireContext(input.threadId, "sendTurn");
      if (context.stopped || !context.sdkSession) {
        return yield* new ProviderAdapterSessionClosedError({
          provider: PROVIDER_STR,
          threadId: input.threadId,
        });
      }

      const turnId = TurnId.make(yield* randomUUIDv4);
      const text = trimOrNull(input.input) ?? "";

      const contentParts: Array<KimiContentPart> = [];
      if (text.length > 0) {
        contentParts.push({ type: "text", text });
      }

      for (const attachment of input.attachments ?? []) {
        if (attachment.type !== "image") continue;
        const attachmentPath = resolveAttachmentPath({
          attachmentsDir: serverConfig.attachmentsDir,
          attachment,
        });
        if (!attachmentPath) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER_STR,
            method: "sendTurn",
            detail: `Invalid attachment id '${attachment.id}'.`,
          });
        }
        const imageBytes = yield* Effect.tryPromise({
          try: async () => {
            const { readFile } = await import("node:fs/promises");
            return await readFile(attachmentPath);
          },
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER_STR,
              method: "sendTurn",
              detail: `Failed to read image attachment '${attachment.id}'.`,
              cause,
            }),
        });
        const dataUrl = `data:${attachment.mimeType};base64,${Buffer.from(imageBytes).toString("base64")}`;
        contentParts.push({ type: "image_url", image_url: { url: dataUrl } });
      }

      if (input.interactionMode !== undefined) {
        context.pendingPlanMode = input.interactionMode === "plan";
      }

      const turn = context.sdkSession.prompt(contentParts.length > 0 ? contentParts : "");
      yield* emitTurnStarted(context, turnId);
      context.streamFiber = yield* Effect.forkDetach(runTurnStream(context, turn));

      return { threadId: input.threadId, turnId };
    });

  const interruptTurn: KimiAdapterShape["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "interruptTurn");
      if (context.currentTurn) {
        yield* Effect.tryPromise({
          try: () => context.currentTurn!.interrupt(),
          catch: (cause) => toRequestError(threadId, "turn/interrupt", cause),
        }).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      }
      if (context.streamFiber) {
        yield* Fiber.interrupt(context.streamFiber);
        context.streamFiber = undefined;
      }
      const sdkState = (context.sdkSession as unknown as { state?: string }).state;
      if (sdkState === "active") {
        yield* Effect.tryPromise({
          try: () => context.sdkSession.close(),
          catch: (cause) => toRequestError(threadId, "session/close", cause),
        }).pipe(Effect.timeout("3 seconds"), Effect.ignore);
        sessions.delete(threadId);
      }
      yield* emitTurnCompleted(context, "interrupted");
    });

  const respondToRequest: KimiAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "respondToRequest");
      const pending = context.pendingApprovals.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER_STR,
          method: "respondToRequest",
          detail: `No pending approval request ${requestId} for thread ${threadId}.`,
        });
      }
      if (context.currentTurn) {
        const response = approvalResponseFromDecision(decision);
        yield* Effect.tryPromise({
          try: () => context.currentTurn!.approve(requestId, response),
          catch: (cause) => toRequestError(threadId, "request/approve", cause),
        }).pipe(Effect.ignore);
      }
      context.pendingApprovals.delete(requestId);
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "request.resolved",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId,
        turnId: context.turnState?.turnId,
        requestId: asRuntimeRequestId(requestId),
        payload: { requestType: pending.requestType, decision },
        providerRefs: {},
      });
    });

  const respondToUserInput: KimiAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "respondToUserInput");
      const pending = context.pendingUserInputs.get(requestId);
      if (!pending) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER_STR,
          method: "respondToUserInput",
          detail: `No pending user input request ${requestId} for thread ${threadId}.`,
        });
      }
      if (context.currentTurn) {
        yield* Effect.tryPromise({
          try: async () => {
            await (context.currentTurn as unknown as {
              respondQuestion(a: string, b: string, c: ProviderUserInputAnswers): Promise<void>;
            }).respondQuestion(requestId, requestId, answers);
          },
          catch: (cause) => toRequestError(threadId, "request/respondQuestion", cause),
        }).pipe(Effect.ignore);
      }
      context.pendingUserInputs.delete(requestId);
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "user-input.resolved",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId,
        turnId: context.turnState?.turnId,
        requestId: asRuntimeRequestId(requestId),
        payload: { answers },
        providerRefs: {},
      });
    });

  const stopSession: KimiAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "stopSession");
      context.stopped = true;
      if (context.streamFiber) {
        yield* Fiber.interrupt(context.streamFiber);
        context.streamFiber = undefined;
      }
      yield* Effect.tryPromise({
        try: () => context.sdkSession.close(),
        catch: (cause) => toRequestError(threadId, "session/close", cause),
      }).pipe(Effect.timeout("5 seconds"), Effect.ignore);
      sessions.delete(threadId);
      yield* emitSessionState(context, "closed");
      const { eventId, createdAt } = yield* makeEventStamp();
      yield* offerRuntimeEvent({
        type: "session.exited",
        eventId,
        provider: PROVIDER,
        createdAt,
        threadId,
        payload: {},
        providerRefs: {},
      });
    });

  const listSessions: KimiAdapterShape["listSessions"] = () =>
    Effect.sync(() =>
      Array.from(sessions.values())
        .filter((ctx) => !ctx.stopped)
        .map((ctx) => ctx.session),
    );

  const hasSession: KimiAdapterShape["hasSession"] = (threadId) =>
    Effect.sync(() => {
      const context = sessions.get(threadId);
      return context !== undefined && !context.stopped;
    });

  const readThread: KimiAdapterShape["readThread"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "readThread");
      return yield* snapshotThread(context);
    });

  const rollbackThread: KimiAdapterShape["rollbackThread"] = (threadId, _numTurns) =>
    Effect.gen(function* () {
      const context = yield* requireContext(threadId, "rollbackThread");
      return yield* snapshotThread(context);
    });

  const stopAll: KimiAdapterShape["stopAll"] = () =>
    Effect.gen(function* () {
      for (const [threadId, context] of sessions) {
        if (context.stopped) continue;
        yield* stopSession(threadId).pipe(Effect.ignore);
      }
    });

  const streamEvents: KimiAdapterShape["streamEvents"] = Stream.fromQueue(runtimeEventQueue);

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents,
  } satisfies KimiAdapterShape;
});
