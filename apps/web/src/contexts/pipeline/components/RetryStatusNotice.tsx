import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { Alert, AlertDescription, AlertTitle } from "../../../shared/ui/alert.js";
import { Button } from "../../../shared/ui/button.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { confirmRetryDetail, retryStatusScope } from "../lib/retryStatusConfirmation.js";

export function RetryStatusNotice({ jobId, detailQueryId }: { jobId: string; detailQueryId: string }): JSX.Element | null {
  const tenantId = useTenantId();
  const queryClient = useQueryClient();
  const scope = retryStatusScope(tenantId, jobId, detailQueryId);
  const notice = useToastStore((state) => state.toasts.find((entry) => entry.scope === scope));
  const owner = useRef<{ noticeId: string; controller: AbortController } | null>(null);
  const pending = useRef<{ noticeId: string; signal: AbortSignal } | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);

  const confirm = useCallback(async (noticeId: string, signal: AbortSignal) => {
    if (signal.aborted || (pending.current?.noticeId === noticeId && pending.current.signal === signal)) return;
    const operation = { noticeId, signal };
    pending.current = operation;
    setCheckingId(noticeId);
    try {
      await confirmRetryDetail(queryClient, jobsKeys.detail(tenantId, detailQueryId), noticeId, jobId, signal);
    } finally {
      if (pending.current === operation) {
        pending.current = null;
        if (!signal.aborted) setCheckingId(null);
      }
    }
  }, [detailQueryId, jobId, queryClient, tenantId]);

  useEffect(() => {
    if (!notice) return;
    const cache = queryClient.getQueryCache();
    const queryKey = jobsKeys.detail(tenantId, detailQueryId);
    const currentOwner = { noticeId: notice.id, controller: new AbortController() };
    owner.current = currentOwner;
    const confirmWhenActive = () => {
      if (!currentOwner.controller.signal.aborted && cache.find({ queryKey, exact: true })?.isActive()) {
        void confirm(notice.id, currentOwner.controller.signal);
      }
    };
    // Child effects may run before Job Detail subscribes to its query. Wait for
    // that observer instead of treating the still-inactive query as confirmed.
    const unsubscribe = cache.subscribe((event) => {
      if (event.type === "observerAdded" && cache.find({ queryKey, exact: true }) === event.query) {
        confirmWhenActive();
      }
    });
    confirmWhenActive();
    return () => {
      currentOwner.controller.abort();
      if (owner.current === currentOwner) owner.current = null;
      unsubscribe();
    };
  }, [confirm, detailQueryId, notice, queryClient, tenantId]);

  if (!notice) return null;
  return (
    <Alert>
      <AlertTitle>Stage status needs confirmation</AlertTitle>
      <AlertDescription>
        <p>{notice.message}</p>
        <Button type="button" size="sm" variant="outline" disabled={checkingId === notice.id}
          onClick={() => {
            const currentOwner = owner.current;
            if (currentOwner?.noticeId === notice.id) void confirm(notice.id, currentOwner.controller.signal);
          }}>
          {checkingId === notice.id ? "Refreshing stage status" : "Refresh stage status"}
        </Button>
      </AlertDescription>
    </Alert>
  );
}
