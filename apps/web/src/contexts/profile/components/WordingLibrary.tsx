import { useForm } from "@tanstack/react-form";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type { SessionPort } from "../../../shared/ports/SessionPort.js";
import { Button } from "../../../shared/ui/button.js";
import {
  discardUnreadableDraft,
  readDraftSlot,
  UnreadableDraftError,
  writeDraftSlot,
  type OwnedDraft,
} from "../lib/owned-draft-slot.js";
import {
  profileDraftGeneration,
  profileSessionIdentity,
  useProfileDraftGeneration,
} from "../lib/profile-draft-state.js";
import {
  useWordingActions,
  clearWordingRecoveryForSession,
  setWordingRecoveryPending,
  useWordingHistory,
  useWordingLibrary,
  wordingVariantSchema,
  type WordingDecision,
  type WordingVariant,
} from "../hooks/useWordingLibrary.js";

const textSchema = z
  .string()
  .refine(
    (value) => value.trim().length > 0,
    "Enter wording before saving a draft.",
  );
const legacyRecoverySchema = z.object({
  text: z.string(),
  baseText: z.string(),
  revision: z.number().int().positive(),
});
const editBaseSchema = z
  .object({
    variantId: z.string(),
    revision: z.number().int().positive(),
    text: z.string(),
    profileVersion: z.number().int().nonnegative().nullable(),
    variant: wordingVariantSchema.nullable(),
  })
  .superRefine((base, context) => {
    if (
      base.variant &&
      (base.variant.variant_id !== base.variantId ||
        base.variant.revision !== base.revision ||
        base.variant.text !== base.text ||
        base.profileVersion === null)
    )
      context.addIssue({
        code: "custom",
        message: "The saved wording base is inconsistent.",
      });
  });
const draftSchema = z.object({ text: z.string(), base: editBaseSchema });
const entrySchema = z
  .object({
    id: z.string().min(1),
    ownerId: z.string().min(1),
    draft: draftSchema,
  })
  .strict();
const recoverySlotSchema = z
  .object({
    entries: z.array(entrySchema),
    legacyFingerprint: z.string().nullable(),
  })
  .strict()
  .superRefine((slot, context) => {
    if (
      new Set(slot.entries.map((entry) => entry.id)).size !==
      slot.entries.length
    )
      context.addIssue({
        code: "custom",
        message: "Recovery entry identities are inconsistent.",
      });
  });
type EditBase = z.infer<typeof editBaseSchema>;
type WordingDraft = z.infer<typeof draftSchema>;
type DraftEntry = z.infer<typeof entrySchema>;
type RecoverySlot = z.infer<typeof recoverySlotSchema>;
type LegacyRecovery = {
  fingerprint: string;
  draft: z.infer<typeof legacyRecoverySchema> | null;
};

// Keep a losing local edit through a React remount even if browser storage fails.
type TabDraft = { draft: WordingDraft; owners: string[]; writerId: string };
const tabDrafts = new Map<string, TabDraft>();
/** Reset only this session and tenant; other workspaces keep their drafts. */
export function clearWordingDraftsForSession(
  session: SessionPort,
  tenant: string,
) {
  const identity = profileSessionIdentity(session);
  const prefix = `profile-wording-draft:v2:${encodeURIComponent(tenant)}:`;
  for (const key of tabDrafts.keys()) {
    const [savedIdentity, , savedRecoveryKey] = JSON.parse(key) as [
      number,
      number,
      string,
    ];
    if (savedIdentity === identity && savedRecoveryKey.startsWith(prefix))
      tabDrafts.delete(key);
  }
  clearWordingRecoveryForSession(session, tenant);
}

function captureBase(
  variant: WordingVariant,
  profileVersion: number,
): EditBase {
  const copy = {
    ...variant,
    source_refs: variant.source_refs.map((source) => ({ ...source })),
  };
  return {
    variantId: copy.variant_id,
    revision: copy.revision,
    text: copy.text,
    profileVersion,
    variant: copy,
  };
}
function isStaleBase(
  base: EditBase,
  variant: WordingVariant,
  profileVersion: number,
): boolean {
  return (
    !base.variant ||
    base.profileVersion === null ||
    base.profileVersion !== profileVersion ||
    base.variantId !== variant.variant_id ||
    base.revision !== variant.revision ||
    base.text !== variant.text ||
    base.variant.status !== variant.status ||
    JSON.stringify(base.variant.source_refs) !==
      JSON.stringify(variant.source_refs)
  );
}
function wordingStatusLabel(status: string) {
  const labels: Record<string, string> = {
    approved: "Approved",
    pending: "Draft",
    rejected: "Rejected",
    deferred: "Deferred",
    stale: "Needs review",
  };
  const text = status.replaceAll("_", " ");
  return (
    labels[status] ??
    (text ? text[0]!.toLocaleUpperCase() + text.slice(1) : text)
  );
}
function sameEntry(a: DraftEntry | undefined, b: DraftEntry): boolean {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

function Variant({
  variant,
  profileVersion,
  kind,
  ordinal,
  context,
  readUnavailable,
  readPending,
  onRetryRead,
}: {
  variant: WordingVariant;
  profileVersion: number;
  kind: "current" | "source" | "proposal" | "history";
  ordinal: number;
  context?: ReactNode;
  readUnavailable: boolean;
  readPending: boolean;
  onRetryRead: () => void;
}) {
  const { storage, requestIdentity, session } = usePorts();
  const tenant = useTenantId();
  const legacyKey = `profile-wording-draft:v1:${tenant}:${variant.variant_id}`;
  const recoveryKey = `profile-wording-draft:v2:${encodeURIComponent(tenant)}:${encodeURIComponent(variant.variant_id)}`;
  const generation = useRef(profileDraftGeneration(session)).current;
  const active = () => generation === profileDraftGeneration(session);
  const memoryKey = JSON.stringify([
    profileSessionIdentity(session),
    generation,
    recoveryKey,
  ]);
  const [ownerId] = useState(() => requestIdentity.create());
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [storageError, setStorageError] = useState("");
  const [slotLoading, setSlotLoading] = useState(true);
  const [unreadable, setUnreadable] = useState<UnreadableDraftError | null>(
    null,
  );
  const [legacy, setLegacy] = useState<LegacyRecovery | null>(null);
  const [slot, setSlot] = useState<OwnedDraft<RecoverySlot> | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<TabDraft | null>(
    () => tabDrafts.get(memoryKey) ?? null,
  );
  const [editBase, setEditBase] = useState<EditBase | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const recoveryVersion = useRef(0);
  const mounted = useRef(true);
  const [undoDraft, setUndoDraft] = useState<WordingDraft | null>(null);
  const slotRef = useRef<OwnedDraft<RecoverySlot> | null>(null);
  const slotEpoch = useRef(0);
  const entryRef = useRef<DraftEntry | null>(null);
  const baseRef = useRef<EditBase | null>(null);
  const currentRef = useRef({
    variant,
    profileVersion,
    readUnavailable,
    readPending,
  });
  const savingRef = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  currentRef.current = {
    variant,
    profileVersion,
    readUnavailable,
    readPending,
  };
  const { decide, draft, edit } = useWordingActions();
  const history = useWordingHistory(variant.variant_id, historyOpen);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const updateSlot = (record: OwnedDraft<RecoverySlot> | null) => {
    slotEpoch.current += 1;
    slotRef.current = record;
    setSlot(record);
  };
  const enqueue = <T,>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.current.then(operation);
    queue.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const inspectLegacy = async (): Promise<LegacyRecovery | null> => {
    if (!storage.readRaw)
      throw new Error("The browser cannot verify older wording recovery data.");
    const raw = storage.readRaw(legacyKey);
    if (raw === null) return null;
    const fingerprint = await requestIdentity.fingerprint(raw);
    try {
      const parsed = legacyRecoverySchema.safeParse(JSON.parse(raw) as unknown);
      return { fingerprint, draft: parsed.success ? parsed.data : null };
    } catch {
      return { fingerprint, draft: null };
    }
  };
  const readRecovery = async () => {
    const epoch = slotEpoch.current;
    setSlotLoading(true);
    setStorageError("");
    setUnreadable(null);
    try {
      const [stored, older] = await Promise.all([
        readDraftSlot(storage, recoveryKey, recoverySlotSchema),
        inspectLegacy(),
      ]);
      if (!active() || slotEpoch.current !== epoch) return;
      updateSlot(stored);
      setLegacy(older);
    } catch (error) {
      if (!active() || slotEpoch.current !== epoch) return;
      if (error instanceof UnreadableDraftError) setUnreadable(error);
      else
        setStorageError(
          "Wording recovery could not be read. Retry before starting another edit; retained copies have not been removed.",
        );
    } finally {
      setSlotLoading(false);
    }
  };
  useEffect(() => {
    void readRecovery();
  }, [recoveryKey, storage]); // eslint-disable-line react-hooks/exhaustive-deps
  const entries = slot?.data.entries ?? [];
  const pendingLegacy =
    !!legacy && legacy.fingerprint !== slot?.data.legacyFingerprint;
  const blocked =
    slotLoading ||
    readUnavailable ||
    readPending ||
    !!unreadable ||
    (!!storageError && !editing) ||
    entries.length > 0 ||
    pendingLegacy ||
    !!memoryDraft;
  const pending =
    saving || decide.isPending || draft.isPending || edit.isPending;

  // Retry an envelope CAS only if the exact entry being edited is unchanged.
  // Other tabs' entries are retained in every proposed replacement.
  const changeSlot = async (
    change: (current: RecoverySlot) => RecoverySlot | null,
  ): Promise<boolean> => {
    let expected = slotRef.current;
    if (!active()) return false;
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        if (!active()) return false;
        const data = expected?.data ?? { entries: [], legacyFingerprint: null };
        const next = change(data);
        if (!next) {
          setStorageError(
            "Another tab changed this recovery copy. Your text remains in this tab; no other copy was replaced.",
          );
          return false;
        }
        const result = await writeDraftSlot(
          storage,
          recoveryKey,
          recoverySlotSchema,
          expected,
          ownerId,
          next,
        );
        if (!active()) return false;
        updateSlot(result.record);
        if (result.state === "written") {
          setStorageError("");
          return true;
        }
        expected = result.record;
      }
      setStorageError(
        "Recovery is changing in another tab. Your text remains in this tab; retry before leaving.",
      );
    } catch (error) {
      if (error instanceof UnreadableDraftError) setUnreadable(error);
      setStorageError(
        "This browser could not update the recovery copy. Your text remains in this tab.",
      );
    }
    return false;
  };
  const markPending = (pending: boolean, owner = ownerId) => {
    setWordingRecoveryPending(session, tenant, generation, owner, pending);
    if (owner === ownerId && mounted.current) setRecoveryPending(pending);
  };
  const clearPendingOwners = (owners: readonly string[]) => {
    for (const owner of new Set([...owners, ownerId]))
      markPending(false, owner);
  };
  const persist = (nextDraft: WordingDraft) => {
    if (!active()) return;
    const version = ++recoveryVersion.current;
    const owners = [
      ...new Set([...(tabDrafts.get(memoryKey)?.owners ?? []), ownerId]),
    ];
    const memory = { draft: nextDraft, owners, writerId: ownerId };
    tabDrafts.set(memoryKey, memory);
    // Register synchronously: the shell reads this even if reload precedes React rendering.
    markPending(true);
    void enqueue(async () => {
      const previous = entryRef.current;
      if (!previous || previous.ownerId !== ownerId) return;
      const next = { ...previous, draft: nextDraft };
      const ok = await changeSlot((current) =>
        sameEntry(
          current.entries.find((item) => item.id === previous.id),
          previous,
        )
          ? {
              ...current,
              entries: current.entries.map((item) =>
                item.id === previous.id ? next : item,
              ),
            }
          : null,
      );
      if (ok) {
        entryRef.current = next;
        if (
          version === recoveryVersion.current &&
          tabDrafts.get(memoryKey) === memory
        )
          clearPendingOwners(owners);
      }
    });
  };
  const openDraft = (
    next: WordingDraft,
    entry: DraftEntry,
    observedMemory: TabDraft | undefined,
    version?: number,
  ) => {
    // A completed operation may belong to an unmounted editor. It must not
    // acknowledge or replace a newer editor's in-memory recovery copy.
    if (
      !active() ||
      tabDrafts.get(memoryKey) !== observedMemory ||
      (version !== undefined && version !== recoveryVersion.current)
    )
      return;
    if (observedMemory) clearPendingOwners(observedMemory.owners);
    if (!mounted.current) return;
    entryRef.current = entry;
    baseRef.current = next.base;
    setEditBase(next.base);
    tabDrafts.set(memoryKey, {
      draft: next,
      owners: [ownerId],
      writerId: ownerId,
    });
    // Unlike reset(values), this keeps React Form's default-value update from
    // replacing a restored, untouched draft on the next render.
    form.setFieldValue("text", next.text);
    setMemoryDraft(null);
    setEditing(true);
  };
  const begin = async (next: WordingDraft) => {
    if (pending || busy || blocked) return;
    const observedMemory = tabDrafts.get(memoryKey);
    if (observedMemory) {
      setMemoryDraft(observedMemory);
      setMessage("Another unfinished edit is available. Review it first.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await enqueue(async () => {
        const [current, older] = await Promise.all([
          readDraftSlot(storage, recoveryKey, recoverySlotSchema),
          inspectLegacy(),
        ]);
        updateSlot(current);
        setLegacy(older);
        const entry: DraftEntry = {
          id: requestIdentity.create(),
          ownerId,
          draft: next,
        };
        const ok = await changeSlot((data) =>
          data.entries.length ||
          (older && older.fingerprint !== data.legacyFingerprint)
            ? null
            : { ...data, entries: [entry] },
        );
        if (ok) openDraft(next, entry, observedMemory);
        else
          setMessage(
            "Resolve the retained recovery copy before starting another edit.",
          );
      });
    } catch (error) {
      if (error instanceof UnreadableDraftError) setUnreadable(error);
      setStorageError(
        "Wording recovery could not be verified. Your saved copies remain unchanged.",
      );
    } finally {
      setBusy(false);
    }
  };
  const restore = async (
    recovered: WordingDraft,
    original?: DraftEntry,
    expectedMemory?: TabDraft,
  ) => {
    if (pending || busy || slotLoading || unreadable) return;
    const observedMemory = tabDrafts.get(memoryKey);
    if (observedMemory !== expectedMemory) {
      setMemoryDraft(observedMemory ?? null);
      setMessage("Another unfinished edit is available. Review it first.");
      return;
    }
    const memory: TabDraft = {
      draft: recovered,
      owners: [...new Set([...(observedMemory?.owners ?? []), ownerId])],
      writerId: ownerId,
    };
    const version = ++recoveryVersion.current;
    tabDrafts.set(memoryKey, memory);
    // Undo may follow a queued discard. Protect the restored text immediately,
    // before that discard's acknowledgement can run.
    markPending(true);
    setBusy(true);
    setMessage("");
    try {
      await enqueue(async () => {
        const entry: DraftEntry = {
          id: requestIdentity.create(),
          ownerId,
          draft: recovered,
        };
        let originalChanged = false;
        const ok = await changeSlot((data) => {
          originalChanged =
            !!original &&
            !sameEntry(
              data.entries.find((item) => item.id === original.id),
              original,
            );
          return { ...data, entries: [...data.entries, entry] };
        });
        if (ok && originalChanged)
          setMessage(
            "That recovery copy changed in another tab. Your restored copy retains the version you selected; the newer copy is also retained.",
          );
        // Even a failed durable write leaves this explicit restoration in this tab.
        if (!active()) return;
        if (ok) openDraft(recovered, entry, memory, version);
        else {
          if (
            !mounted.current ||
            tabDrafts.get(memoryKey) !== memory ||
            version !== recoveryVersion.current
          )
            return;
          entryRef.current = null;
          baseRef.current = recovered.base;
          setEditBase(recovered.base);
          form.setFieldValue("text", recovered.text);
          setMemoryDraft(null);
          setEditing(true);
        }
      });
    } finally {
      setBusy(false);
    }
  };
  const discardStored = async (target: DraftEntry) => {
    if (busy) return;
    setBusy(true);
    try {
      const removed = await enqueue(() =>
        changeSlot((data) =>
          sameEntry(
            data.entries.find((item) => item.id === target.id),
            target,
          )
            ? {
                ...data,
                entries: data.entries.filter((item) => item.id !== target.id),
              }
            : null,
        ),
      );
      if (removed && !tabDrafts.get(memoryKey)?.owners.includes(target.ownerId))
        markPending(false, target.ownerId);
    } finally {
      setBusy(false);
    }
  };
  const resolveLegacy = async (restoreOlder: boolean) => {
    if (!legacy || busy || memoryDraft) return;
    const observedMemory = tabDrafts.get(memoryKey);
    if (observedMemory) {
      setMemoryDraft(observedMemory);
      setMessage("Another unfinished edit is available. Review it first.");
      return;
    }
    setBusy(true);
    try {
      await enqueue(async () => {
        const latest = await inspectLegacy();
        if (!latest || latest.fingerprint !== legacy.fingerprint) {
          setLegacy(latest);
          setMessage("The older recovery copy changed. Review it again.");
          return;
        }
        const old = latest.draft;
        const recovered: WordingDraft | null =
          restoreOlder && old
            ? {
                text: old.text,
                base: {
                  variantId: variant.variant_id,
                  revision: old.revision,
                  text: old.baseText,
                  profileVersion: null,
                  variant: null,
                },
              }
            : null;
        const entry: DraftEntry | null = recovered
          ? { id: requestIdentity.create(), ownerId, draft: recovered }
          : null;
        const ok = await changeSlot((data) => ({
          ...data,
          legacyFingerprint: latest.fingerprint,
          entries: entry ? [...data.entries, entry] : data.entries,
        }));
        if (ok && recovered && entry)
          openDraft(recovered, entry, observedMemory);
      });
    } catch (error) {
      if (error instanceof UnreadableDraftError) setUnreadable(error);
      setStorageError(
        "The older recovery copy could not be reviewed. It remains unchanged.",
      );
    } finally {
      setBusy(false);
    }
  };
  const removeOwnedEntry = async () => {
    const previous = entryRef.current;
    if (!previous) return true;
    if (previous.ownerId !== ownerId) return false;
    const ok = await changeSlot((data) =>
      sameEntry(
        data.entries.find((item) => item.id === previous.id),
        previous,
      )
        ? {
            ...data,
            entries: data.entries.filter((item) => item.id !== previous.id),
          }
        : null,
    );
    if (ok) entryRef.current = null;
    return ok;
  };
  const form = useForm({
    defaultValues: { text: variant.text },
    onSubmit: async ({ value }) => {
      const parsed = textSchema.safeParse(value.text);
      if (!parsed.success) {
        setMessage("Enter wording before saving a draft.");
        return;
      }
      if (!active()) {
        setMessage("The workspace changed. Reload before saving this wording.");
        return;
      }
      const captured = baseRef.current;
      if (!captured || !captured.variant || captured.profileVersion === null) {
        setMessage(
          "Review the current wording before saving this recovered draft.",
        );
        return;
      }
      if (
        currentRef.current.readUnavailable ||
        currentRef.current.readPending
      ) {
        setMessage(
          "The saved wording could not be verified yet. Retry the read before saving your draft.",
        );
        return;
      }
      if (
        isStaleBase(
          captured,
          currentRef.current.variant,
          currentRef.current.profileVersion,
        )
      ) {
        setMessage(
          "The saved wording or Profile changed. Review the current version before saving.",
        );
        return;
      }
      if (parsed.data === captured.text) {
        setMessage("The wording is unchanged.");
        return;
      }
      const submittedMemory = tabDrafts.get(memoryKey);
      if (
        submittedMemory?.writerId === ownerId &&
        (submittedMemory.draft.text !== parsed.data ||
          JSON.stringify(submittedMemory.draft.base) !==
            JSON.stringify(captured))
      ) {
        setMessage("The local edit changed. Review it before saving.");
        return;
      }
      savingRef.current = true;
      setSaving(true);
      try {
        await queue.current;
        if (!active()) return;
        const mutation = captured.variant.status === "pending" ? edit : draft;
        await mutation.mutateAsync({
          variant: captured.variant,
          text: parsed.data,
          profileVersion: captured.profileVersion,
        });
        await enqueue(removeOwnedEntry);
        const acknowledgedMemory =
          submittedMemory?.writerId === ownerId &&
          tabDrafts.get(memoryKey) === submittedMemory;
        if (acknowledgedMemory) {
          clearPendingOwners(submittedMemory.owners);
          tabDrafts.delete(memoryKey);
        }
        if (!active() || !mounted.current) return;
        if (submittedMemory && !acknowledgedMemory) {
          setMessage(
            "The submitted wording was saved. A newer unfinished edit remains available.",
          );
          return;
        }
        setMemoryDraft(null);
        baseRef.current = null;
        setEditBase(null);
        form.reset({ text: parsed.data });
        setEditing(false);
        setUndoDraft(null);
        setMessage(
          "Proposed revision saved. Review its exact text before approving.",
        );
      } catch {
        /* Keep the original base and text on conflicts and uncertain writes. */
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    },
  });
  const stale = !!editBase && isStaleBase(editBase, variant, profileVersion);
  const rebase = () => {
    const next = captureBase(variant, profileVersion);
    const local = { text: form.state.values.text, base: next };
    baseRef.current = next;
    setEditBase(next);
    persist(local);
    setMessage(
      "Your draft now uses the current wording as its reviewed base. Check the text before saving.",
    );
  };
  const decision = (value: WordingDecision) => {
    if (form.state.isDirty || editing || blocked) {
      setMessage("Resolve unfinished edits before reviewing this wording.");
      return;
    }
    decide.mutate({ variant, decision: value, profileVersion });
  };
  useEffect(() => {
    // Opening/restoring sets the captured base before React commits editing=true;
    // an effect from the prior render must not reset the restored draft.
    if (!form.state.isDirty && !editing && baseRef.current === null)
      form.reset({ text: variant.text });
  }, [editing, form, variant.text]);
  const title =
    kind === "current"
      ? "Current wording"
      : kind === "source"
        ? "Saved wording"
        : kind === "proposal"
          ? `Proposed revision ${ordinal}`
          : `Earlier wording ${ordinal}`;
  return (
    <article
      className="profile-wording-card"
      data-kind={kind}
      aria-label={title}
    >
      {kind === "proposal" || kind === "history" ? (
        <div className="profile-wording-card__heading">
          <h4>{title}</h4>
          <span className="status-badge" data-state={variant.status}>
            {wordingStatusLabel(variant.status)}
          </span>
        </div>
      ) : null}
      <p className="profile-wording-text">{variant.text}</p>
      {context}
      {!editing && slotLoading ? (
        <p role="status">Checking saved wording recovery…</p>
      ) : null}
      {!editing && memoryDraft ? (
        <div className="profile-draft-recovery" role="status">
          <p>
            This tab has an unfinished wording edit. Other saved recovery copies
            remain separate.
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={busy || slotLoading}
            onClick={() =>
              void restore(memoryDraft.draft, undefined, memoryDraft)
            }
          >
            Restore this tab’s edit
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (tabDrafts.get(memoryKey) === memoryDraft) {
                clearPendingOwners(memoryDraft.owners);
                tabDrafts.delete(memoryKey);
                setMemoryDraft(null);
              } else {
                setMemoryDraft(tabDrafts.get(memoryKey) ?? null);
                setMessage(
                  "Another unfinished edit is available. Review it first.",
                );
              }
            }}
          >
            Discard this tab’s edit
          </Button>
        </div>
      ) : null}
      {!editing && !memoryDraft && entries.length ? (
        <p className="muted">
          Restoring makes a separate copy, so work in another tab remains
          available.
        </p>
      ) : null}
      {!editing &&
        !memoryDraft &&
        entries.map((entry, index) => (
          <div role="status" className="profile-draft-recovery" key={entry.id}>
            <p>
              Saved edit {index + 1} · wording revision{" "}
              {entry.draft.base.revision}
              {isStaleBase(entry.draft.base, variant, profileVersion)
                ? " · source needs review"
                : ""}
              .
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void restore(entry.draft, entry)}
            >
              Restore unfinished edit
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => void discardStored(entry)}
            >
              Discard recovery copy
            </Button>
          </div>
        ))}
      {!editing && !memoryDraft && pendingLegacy ? (
        <div role="status" className="profile-draft-recovery">
          <p>
            {legacy?.draft
              ? "An older unfinished wording edit needs review. Its original Profile revision was not recorded."
              : "An older wording recovery copy could not be read. Its bytes remain stored."}
          </p>
          {legacy?.draft ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void resolveLegacy(true)}
            >
              Restore older edit
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => void resolveLegacy(false)}
          >
            Keep older copy and continue
          </Button>
        </div>
      ) : null}
      {!editing && unreadable ? (
        <div role="alert" className="profile-draft-recovery">
          <p>{unreadable.message}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void readRecovery()}
          >
            Retry recovery read
          </Button>
          <Button
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void discardUnreadableDraft(storage, recoveryKey, unreadable)
                .then((removed) => {
                  if (removed) {
                    setUnreadable(null);
                    void readRecovery();
                  } else
                    setStorageError(
                      "The recovery copy changed. Retry before removing it.",
                    );
                })
                .catch(() =>
                  setStorageError(
                    "The unreadable recovery copy could not be removed.",
                  ),
                )
                .finally(() => setBusy(false));
            }}
          >
            Discard unreadable recovery copy
          </Button>
        </div>
      ) : null}
      {!editing && storageError && !unreadable ? (
        <div role="alert">
          <p>{storageError}</p>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void readRecovery()}
          >
            Retry recovery read
          </Button>
        </div>
      ) : null}
      <div className="profile-wording-actions">
        {kind === "current" || kind === "source" ? (
          <span className="profile-wording-caption">
            {title} · {wordingStatusLabel(variant.status)}
          </span>
        ) : null}
        {variant.status !== "approved" && variant.status !== "stale" ? (
          <>
            <Button
              type="button"
              disabled={pending || editing || blocked || busy}
              onClick={() => decision("approve")}
            >
              Approve exact wording
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || editing || blocked || busy}
              onClick={() => decision("reject")}
            >
              Reject
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={pending || editing || blocked || busy}
              onClick={() => decision("defer")}
            >
              Defer
            </Button>
          </>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={
            pending || editing || blocked || busy || variant.status === "stale"
          }
          onClick={() =>
            void begin({
              text: variant.text,
              base: captureBase(variant, profileVersion),
            })
          }
        >
          {variant.status === "pending"
            ? "Edit draft"
            : kind === "current" || kind === "source"
              ? "Edit wording"
              : "Propose revision"}
        </Button>
      </div>
      {editing ? (
        <div className="profile-wording-edit">
          {recoveryPending ? (
            <p role="status">
              {storageError
                ? "Recovery is not confirmed; keep this page open or save the wording."
                : "Saving recovery copy…"}
            </p>
          ) : null}
          {readUnavailable ? (
            <p role="alert">
              The latest saved wording could not be verified. Your draft remains
              here.{" "}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onRetryRead}
              >
                Retry saved wording
              </Button>
            </p>
          ) : null}
          {stale ? (
            <div role="alert" className="profile-draft-recovery">
              <p>
                The saved wording or Profile changed after this edit began. Your
                draft is retained; saving is paused until you review the current
                version.
              </p>
              <p>
                <strong>Original wording</strong>
              </p>
              <p>{editBase?.text}</p>
              <p>
                <strong>Current saved wording</strong>
              </p>
              <p>{variant.text}</p>
              <Button
                type="button"
                variant="outline"
                disabled={
                  pending ||
                  busy ||
                  readUnavailable ||
                  readPending ||
                  variant.status === "stale"
                }
                onClick={rebase}
              >
                Use current wording as the base for my draft
              </Button>
            </div>
          ) : null}
          <form.Field name="text">
            {(field) => (
              <label>
                Wording text
                <textarea
                  className="w-full"
                  rows={5}
                  disabled={pending}
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(event) => {
                    if (savingRef.current) return;
                    field.handleChange(event.currentTarget.value);
                    if (baseRef.current)
                      persist({
                        text: event.currentTarget.value,
                        base: baseRef.current,
                      });
                  }}
                />
              </label>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.text}>
            {(text) =>
              text !== editBase?.text ? (
                <div
                  className="profile-wording-comparison"
                  aria-label="Literal text changes"
                >
                  <p>Text changes</p>
                  <div>
                    <span>Original wording</span>
                    <del>{editBase?.text}</del>
                  </div>
                  <div>
                    <span>Your draft</span>
                    <ins>{text}</ins>
                  </div>
                </div>
              ) : null
            }
          </form.Subscribe>
          <p className="muted">
            {editBase?.variant?.status === "pending"
              ? "Saving updates this draft and retains its earlier revisions."
              : "Saving creates a proposed revision and preserves this exact reviewed wording."}
          </p>
          <div className="profile-wording-actions">
            <Button
              type="button"
              disabled={
                pending || stale || busy || readUnavailable || readPending
              }
              onClick={() => void form.handleSubmit()}
            >
              Save wording draft
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={pending || busy}
              onClick={() => {
                const old = baseRef.current
                  ? { text: form.state.values.text, base: baseRef.current }
                  : null;
                setUndoDraft(old);
                const memory = tabDrafts.get(memoryKey);
                const ownsMemory = memory?.writerId === ownerId;
                const owners = ownsMemory ? memory.owners : [ownerId];
                const version = ++recoveryVersion.current;
                markPending(true);
                if (ownsMemory) tabDrafts.delete(memoryKey);
                setMemoryDraft(null);
                baseRef.current = null;
                setEditBase(null);
                form.reset({ text: variant.text });
                setEditing(false);
                void enqueue(async () => {
                  const removed = await removeOwnedEntry();
                  if (
                    removed &&
                    version === recoveryVersion.current &&
                    (!ownsMemory || !tabDrafts.has(memoryKey))
                  )
                    clearPendingOwners(owners);
                });
              }}
            >
              Discard edit
            </Button>
          </div>
        </div>
      ) : null}
      {undoDraft && !editing ? (
        <Button
          type="button"
          variant="ghost"
          disabled={busy || slotLoading || !!unreadable}
          onClick={() => void restore(undoDraft)}
        >
          Undo discarded edit
        </Button>
      ) : null}
      <details
        className="profile-wording-audit"
        onToggle={(event) => setHistoryOpen(event.currentTarget.open)}
      >
        <summary>Approval and history</summary>
        <p>
          {variant.provenance?.["authority"] === "imported_authored_baseline"
            ? "Imported original wording; historical confirmation is unknown."
            : variant.provenance?.["authority"] === "authored_save"
              ? "Authored original wording."
              : "Wording is reviewed independently from factual evidence."}
        </p>
        <p>
          Revision {variant.revision}
          {variant.approval_id
            ? " · Exact wording approval recorded"
            : " · No exact approval recorded"}
        </p>
        {variant.source_refs.length ? (
          <ul>
            {variant.source_refs.map((source) => (
              <li key={`${source.source_id}:${source.revision}`}>
                {source.source_id}, revision {source.revision}
              </li>
            ))}
          </ul>
        ) : (
          <p>No source references recorded.</p>
        )}
        <h5>Earlier revisions</h5>
        {historyOpen && history.isPending ? <p>Loading revisions…</p> : null}
        {history.data?.revisions.map((item) => (
          <div key={item.revision}>
            <p>
              Revision {item.revision} · {wordingStatusLabel(item.status)}
            </p>
            <p>{item.text}</p>
            {item.text !== variant.text ? (
              <Button
                type="button"
                variant="outline"
                disabled={
                  pending ||
                  editing ||
                  blocked ||
                  busy ||
                  variant.status === "stale"
                }
                onClick={() =>
                  void begin({
                    text: item.text,
                    base: captureBase(variant, profileVersion),
                  })
                }
              >
                Restore text as draft
              </Button>
            ) : null}
          </div>
        ))}
        {history.error ? <p role="alert">{history.error.message}</p> : null}
      </details>
      {message ? <p role="status">{message}</p> : null}
      {editing && storageError ? <p role="alert">{storageError}</p> : null}
      {decide.error || draft.error || edit.error ? (
        <p role="alert">
          {(decide.error ?? draft.error ?? edit.error)?.message} Your text and
          earlier approved wording remain available.
        </p>
      ) : null}
    </article>
  );
}

export interface CurrentAchievementWording {
  readonly variant_id: string;
  readonly variant_revision: number;
  readonly requirement_id: string;
  readonly requirement_revision: number | string;
}

export function AchievementWordings({
  achievementId,
  currentWordings = [],
  hasSavedAssignment = false,
  assignmentsUnavailable = false,
  wordingContext,
}: {
  readonly achievementId: string;
  readonly currentWordings?: readonly CurrentAchievementWording[];
  readonly hasSavedAssignment?: boolean;
  readonly assignmentsUnavailable?: boolean;
  readonly wordingContext?: (
    variantId: string,
    variantRevision: number,
  ) => ReactNode;
}) {
  const tenantId = useTenantId();
  const { session } = usePorts();
  const generation = useProfileDraftGeneration(session);
  useEffect(() => {
    const identity = profileSessionIdentity(session);
    for (const key of tabDrafts.keys()) {
      const [savedIdentity, savedGeneration] = JSON.parse(key) as [
        number,
        number,
      ];
      if (savedIdentity === identity && savedGeneration !== generation)
        tabDrafts.delete(key);
    }
  }, [session, generation]);
  const library = useWordingLibrary();
  const variants =
    library.data?.variants.filter(
      (variant) => variant.achievement_id === achievementId,
    ) ?? [];
  const baselineId = library.data?.roles
    .flatMap((role) => role.achievements)
    .find((item) => item.achievement_id === achievementId)?.baseline_variant_id;
  const maintained = variants.filter(
    (variant) =>
      variant.status === "approved" &&
      currentWordings.some(
        (binding) =>
          binding.variant_id === variant.variant_id &&
          binding.variant_revision === variant.revision,
      ),
  );
  const authored = variants.find(
    (variant) => variant.variant_id === baselineId,
  );
  const displayed = maintained.length ? maintained : authored ? [authored] : [];
  const displayedIds = new Set(displayed.map((variant) => variant.variant_id));
  const proposals = variants.filter(
    (variant) =>
      variant.status === "pending" && !displayedIds.has(variant.variant_id),
  );
  const history = variants.filter(
    (variant) =>
      variant.status !== "pending" && !displayedIds.has(variant.variant_id),
  );
  const card = (
    variant: WordingVariant,
    kind: "current" | "source" | "proposal" | "history",
    ordinal: number,
  ) =>
    library.data?.profileVersion != null ? (
      <Variant
        key={JSON.stringify([
          profileSessionIdentity(session),
          generation,
          tenantId,
          variant.variant_id,
        ])}
        variant={variant}
        profileVersion={library.data.profileVersion}
        kind={kind}
        ordinal={ordinal}
        context={wordingContext?.(variant.variant_id, variant.revision)}
        readUnavailable={!!library.error}
        readPending={library.isFetching}
        onRetryRead={() => {
          void library.refetch();
        }}
      />
    ) : null;
  return (
    <div
      className="profile-achievement-wordings"
      aria-label="Achievement wording"
    >
      {library.error ? (
        <p role="alert">
          {library.error.message}{" "}
          <Button
            type="button"
            variant="outline"
            onClick={() => void library.refetch()}
          >
            Retry wording
          </Button>
        </p>
      ) : null}
      {library.isPending ? <p>Loading saved wording…</p> : null}
      {library.data && !variants.length ? (
        <p className="muted">Save this achievement to review its wording.</p>
      ) : null}
      {!maintained.length &&
      authored &&
      (assignmentsUnavailable || hasSavedAssignment) ? (
        <p role="status">
          {assignmentsUnavailable
            ? "Requirement-specific selections are unavailable. Saved wording is retained."
            : "The saved requirement wording needs review. Original wording is retained."}
        </p>
      ) : null}
      {library.data &&
      currentWordings.some(
        (binding) =>
          !maintained.some(
            (variant) =>
              variant.variant_id === binding.variant_id &&
              variant.revision === binding.variant_revision,
          ),
      ) ? (
        <p role="alert">
          A saved current-wording reference could not be resolved to its exact
          approved text. Review the assignment; the authored source and earlier
          wording are retained.
        </p>
      ) : null}
      {displayed.map((variant, index) =>
        card(variant, maintained.length ? "current" : "source", index + 1),
      )}
      {proposals.length ? (
        <details className="profile-wording-proposals" open>
          <summary>Proposed revisions ({proposals.length})</summary>
          <p>
            Review these changes before use. Exact wording approval and current
            requirement coverage are separate decisions.
          </p>
          {proposals.map((variant, index) =>
            card(variant, "proposal", index + 1),
          )}
        </details>
      ) : null}
      {history.length ? (
        <details className="profile-wording-history">
          <summary>
            Earlier wording and review history ({history.length})
          </summary>
          {history.map((variant, index) => card(variant, "history", index + 1))}
        </details>
      ) : null}
      {library.data?.proposals
        .filter(
          (proposal) =>
            proposal["achievement_id"] === achievementId &&
            proposal.failure_code,
        )
        .map((proposal) => (
          <p role="status" key={proposal.proposal_id}>
            Wording preparation {proposal.status}: {proposal.failure_code}.
            Earlier approved wording is retained.
          </p>
        ))}
    </div>
  );
}

/** Retained public library for existing compositions; Experience embeds the same cards. */
export function WordingLibrary() {
  const library = useWordingLibrary();
  return (
    <section
      id="profile-wording"
      className="card"
      aria-labelledby="profile-wording-title"
    >
      <h2 id="profile-wording-title">Achievement wordings</h2>
      {library.data?.roles.map((role) => (
        <section key={role.role_id}>
          {role.achievements.map((achievement) => (
            <AchievementWordings
              key={achievement.achievement_id}
              achievementId={achievement.achievement_id}
            />
          ))}
        </section>
      ))}
      {library.error ? <p role="alert">{library.error.message}</p> : null}
    </section>
  );
}
