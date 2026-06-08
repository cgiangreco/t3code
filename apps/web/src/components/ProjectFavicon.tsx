import type { EnvironmentId } from "@t3tools/contracts";
import { FolderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  resolveEnvironmentHttpUrl,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";

const loadedProjectFaviconSrcs = new Set<string>();
const fetchedProjectFaviconObjectUrls = new Map<string, string>();

export function ProjectFavicon(input: {
  environmentId: EnvironmentId;
  cwd: string;
  className?: string;
}) {
  const rawHttpToken = useSavedEnvironmentRuntimeStore(
    (state) => state.byId[input.environmentId]?.rawHttpToken ?? null,
  );
  const src = useMemo(() => {
    try {
      return resolveEnvironmentHttpUrl({
        environmentId: input.environmentId,
        pathname: "/api/project-favicon",
        searchParams: { cwd: input.cwd },
      });
    } catch {
      return null;
    }
  }, [input.cwd, input.environmentId, rawHttpToken]);
  const [displaySrc, setDisplaySrc] = useState<string | null>(() => {
    if (!src) {
      return null;
    }

    return rawHttpToken ? (fetchedProjectFaviconObjectUrls.get(src) ?? null) : src;
  });
  const [status, setStatus] = useState<"loading" | "loaded" | "error">(() =>
    src && loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading",
  );

  useEffect(() => {
    if (!src) {
      setDisplaySrc(null);
      setStatus("error");
      return;
    }

    if (!rawHttpToken) {
      setDisplaySrc(src);
      setStatus(loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading");
      return;
    }

    const cachedObjectUrl = fetchedProjectFaviconObjectUrls.get(src);
    if (cachedObjectUrl) {
      setDisplaySrc(cachedObjectUrl);
      setStatus(loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading");
      return;
    }

    const abortController = new AbortController();
    setDisplaySrc(null);
    setStatus("loading");
    const loadRemoteProjectFavicon = window.desktopBridge?.fetchProjectFavicon
      ? window.desktopBridge
          .fetchProjectFavicon({
            url: src,
            ...(rawHttpToken ? { bearerToken: rawHttpToken } : {}),
          })
          .then((value) => {
            if (!value) {
              throw new Error("Desktop bridge returned no favicon data.");
            }
            return value;
          })
      : fetch(src, {
          signal: abortController.signal,
        })
          .then(async (response) => {
            if (!response.ok) {
              throw new Error(`Failed to fetch project favicon: ${response.status}`);
            }
            return await response.blob();
          })
          .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            fetchedProjectFaviconObjectUrls.set(src, objectUrl);
            return objectUrl;
          });
    void loadRemoteProjectFavicon
      .then((resolvedSrc) => {
        if (abortController.signal.aborted) {
          return;
        }

        if (!window.desktopBridge?.fetchProjectFavicon) {
          fetchedProjectFaviconObjectUrls.set(src, resolvedSrc);
        }
        setDisplaySrc(resolvedSrc);
        setStatus(loadedProjectFaviconSrcs.has(src) ? "loaded" : "loading");
      })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }

        console.error("[PROJECT_FAVICON] fetch failed", error);
        setStatus("error");
      });

    return () => {
      abortController.abort();
    };
  }, [rawHttpToken, src]);

  if (!src) {
    return (
      <FolderIcon
        className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
      />
    );
  }

  return (
    <>
      {status !== "loaded" ? (
        <FolderIcon
          className={`size-3.5 shrink-0 text-muted-foreground/50 ${input.className ?? ""}`}
        />
      ) : null}
      <img
        src={displaySrc ?? undefined}
        alt=""
        className={`size-3.5 shrink-0 rounded-sm object-contain ${status === "loaded" ? "" : "hidden"} ${input.className ?? ""}`}
        onLoad={() => {
          loadedProjectFaviconSrcs.add(src);
          setStatus("loaded");
        }}
        onError={() => setStatus("error")}
      />
    </>
  );
}
