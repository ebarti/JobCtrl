import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import type { ProfileConfigResponse } from "@jobctrl/contracts";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { readProfile } from "../client.js";
import { sameJson } from "../lib/json-record.js";
import type { ProfileFormValues } from "../forms/profile-form.js";
import {
  readDraftSlot,
  writeDraftSlot,
  discardUnreadableDraft,
  UnreadableDraftError,
  type OwnedDraft,
} from "../lib/owned-draft-slot.js";
import {
  getProfileSessionDraft,
  profileSnapshotValues,
  profileRecoveryMatchesSaved,
  setProfileSessionDraft,
  safeProfileChanges,
  profileRecoverySchema,
  profileDraftGeneration,
  hasPrivateDraftChanges,
  type ProfileSafeRecovery,
  type ProfileSessionDraft,
} from "../lib/profile-draft-state.js";

const legacySchema = z.object({
  base: z
    .object({
      ok: z.literal(true),
      profileVersion: z.number().nullable(),
      profile: z.record(z.string(), z.unknown()),
      style: z.record(z.string(), z.unknown()),
      templateText: z.string(),
    })
    .passthrough(),
  values: z.object({
    profile: z.record(z.string(), z.unknown()).nullable(),
    style: z.record(z.string(), z.unknown()).nullable(),
    templateText: z.string(),
  }),
});
interface ProfileDraftRecoveryProps {
  readonly base: ProfileConfigResponse;
  readonly canonical: ProfileConfigResponse;
  readonly values: ProfileFormValues;
  readonly isDirty: boolean;
  readonly isSubmitting: boolean;
  readonly section: string;
  readonly onRestore: (
    record: ProfileSafeRecovery,
    sessionDraft: ProfileSessionDraft | undefined,
    force: boolean,
  ) => boolean;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onRecoveryPendingChange: (pending: boolean) => void;
}
export function ProfileDraftRecovery(props: ProfileDraftRecoveryProps) {
  const tenant = useTenantId();
  return (
    <TenantProfileDraftRecovery key={`${tenant}:${props.section}`} {...props} />
  );
}
function TenantProfileDraftRecovery({
  base,
  canonical,
  values,
  isDirty,
  isSubmitting,
  section,
  onRestore,
  onDirtyChange,
  onRecoveryPendingChange,
}: ProfileDraftRecoveryProps) {
  const { storage, session, requestIdentity, http } = usePorts();
  const tenant = useTenantId();
  const key = `profile-editor-recovery:v2:${tenant}:${section}`;
  const legacyKey = `profile-editor-recovery:v1:${tenant}`;
  const memoryAtMount = useRef(
    getProfileSessionDraft(session, tenant, section),
  );
  const ownerId = useRef(
    memoryAtMount.current?.ownerId ?? requestIdentity.create(),
  ).current;
  const generation = useRef(profileDraftGeneration(session)).current;
  const token = useRef<OwnedDraft<ProfileSafeRecovery> | null>(null);
  const writes = useRef(Promise.resolve());
  const [state, setState] = useState<{
    ready: boolean;
    unresolved: boolean;
    record: OwnedDraft<ProfileSafeRecovery> | null;
    error: Error | null;
  }>({ ready: false, unresolved: false, record: null, error: null });
  const [legacyPresent, setLegacyPresent] = useState(false);
  const [restoreConflict, setRestoreConflict] = useState(false);
  const [message, setMessage] = useState("");
  const live = useRef({ base, canonical, values, isDirty, isSubmitting });
  live.current = { base, canonical, values, isDirty, isSubmitting };
  const active = () => generation === profileDraftGeneration(session);
  const load = async () => {
    try {
      let record = await readDraftSlot(storage, key, profileRecoverySchema);
      if (section === "profile" && storage.readRaw) {
        const legacyRaw = storage.readRaw(legacyKey);
        setLegacyPresent(legacyRaw !== null);
        if (legacyRaw !== null) {
          let legacyValue: unknown;
          try {
            legacyValue = JSON.parse(legacyRaw);
          } catch {
            throw new Error(
              "The older Profile recovery copy could not be read. Retry or explicitly discard the older copy.",
            );
          }
          const legacy = legacySchema.safeParse(legacyValue);
          if (!legacy.success)
            throw new Error(
              "An earlier recovery copy could not be safely migrated. Explicitly discard that older copy to continue.",
            );
          if (record !== null)
            throw new Error(
              "A separate older recovery copy also exists. Resolve the current draft, then explicitly discard the older copy.",
            );
          const fullBase = legacy.data.base as unknown as ProfileConfigResponse;
          const data: ProfileSafeRecovery = {
            version: 2,
            baseProfileVersion: fullBase.profileVersion,
            changes: safeProfileChanges(
              profileSnapshotValues(fullBase),
              legacy.data.values,
            ),
          };
          const migrated = await writeDraftSlot(
            storage,
            key,
            profileRecoverySchema,
            null,
            ownerId,
            data,
          );
          if (migrated.state === "conflict")
            throw new Error(
              "Another tab retained a draft during recovery migration. Retry before editing.",
            );
          record = migrated.record;
          memoryAtMount.current = {
            ownerId,
            base: fullBase,
            values: legacy.data.values,
          };
          setProfileSessionDraft(
            session,
            tenant,
            section,
            memoryAtMount.current,
          );
          if (storage.readRaw(legacyKey) !== legacyRaw)
            throw new Error(
              "The earlier browser draft changed during migration. Keep this page open and resolve the retained copy before editing.",
            );
          storage.remove(legacyKey);
          setLegacyPresent(false);
        }
      }
      if (!active()) return;
      // The edit base stays frozen while dirty and cannot prove canonical
      // persistence. A newer saved snapshot plus a fresh read can prove that a
      // retained patch already reached Profile; newer drafts stay untouched.
      const suppliedCanonical = live.current.canonical;
      const isNewer = (
        snapshot: ProfileConfigResponse,
        baseVersion: number | null,
      ) =>
        snapshot.profileVersion !== null &&
        snapshot.profileVersion > (baseVersion ?? 0);
      const currentMemory = getProfileSessionDraft(session, tenant, section);
      const possibleSavedRecord =
        record &&
        isNewer(suppliedCanonical, record.data.baseProfileVersion) &&
        profileRecoveryMatchesSaved(
          record.data,
          profileSnapshotValues(suppliedCanonical),
        );
      const possibleSavedMemory =
        currentMemory &&
        isNewer(suppliedCanonical, currentMemory.base.profileVersion) &&
        sameJson(
          currentMemory.values,
          profileSnapshotValues(suppliedCanonical),
        );
      const confirmedCanonical =
        possibleSavedRecord || possibleSavedMemory
          ? await readProfile(http)
          : null;
      if (!active()) return;
      if (
        record &&
        confirmedCanonical &&
        isNewer(confirmedCanonical, record.data.baseProfileVersion) &&
        profileRecoveryMatchesSaved(
          record.data,
          profileSnapshotValues(confirmedCanonical),
        )
      ) {
        const cleaned = await writeDraftSlot(
          storage,
          key,
          profileRecoverySchema,
          record,
          ownerId,
          null,
        );
        if (!active()) return;
        record = cleaned.record;
      }
      const memory = getProfileSessionDraft(session, tenant, section);
      if (
        memory &&
        confirmedCanonical &&
        isNewer(confirmedCanonical, memory.base.profileVersion) &&
        sameJson(memory.values, profileSnapshotValues(confirmedCanonical))
      ) {
        setProfileSessionDraft(session, tenant, section, null);
        if (
          memoryAtMount.current?.ownerId === memory.ownerId &&
          sameJson(memoryAtMount.current.values, memory.values)
        )
          memoryAtMount.current = undefined;
      } else if (memory && memoryAtMount.current) {
        memoryAtMount.current = memory;
      }
      const retryingOwnedDraft =
        live.current.isDirty &&
        (!record ||
          (record.ownerId === ownerId &&
            token.current?.revision === record.revision));
      token.current = retryingOwnedDraft ? record : null;
      setState({
        ready: true,
        unresolved:
          !retryingOwnedDraft &&
          (record !== null || memoryAtMount.current !== undefined),
        record,
        error: null,
      });
    } catch (error) {
      if (active())
        setState((previous) => ({
          ...previous,
          ready: true,
          error:
            error instanceof Error
              ? error
              : new Error("Recovery storage is unavailable."),
        }));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const blocked = !state.ready || state.unresolved || state.error !== null;
  useLayoutEffect(() => {
    onRecoveryPendingChange(blocked);
  }, [blocked, onRecoveryPendingChange]);
  useEffect(() => {
    onDirtyChange?.(isDirty || isSubmitting);
  }, [isDirty, isSubmitting, onDirtyChange]);
  const serialized = JSON.stringify(values);
  useEffect(() => {
    if (!active()) return;
    if (isDirty)
      setProfileSessionDraft(session, tenant, section, {
        ownerId,
        base,
        values,
      });
    if (blocked) return;
    const data = isDirty
      ? {
          version: 2 as const,
          baseProfileVersion: base.profileVersion,
          changes: safeProfileChanges(profileSnapshotValues(base), values),
        }
      : null;
    writes.current = writes.current
      .then(async () => {
        if (!active() || (isSubmitting && !isDirty)) return;
        if (!isDirty && token.current === null) {
          setProfileSessionDraft(session, tenant, section, null);
          return;
        }
        const result = await writeDraftSlot(
          storage,
          key,
          profileRecoverySchema,
          token.current,
          ownerId,
          data?.changes.length ? data : null,
        );
        if (!active()) return;
        if (result.state === "conflict" && result.record === null && !isDirty) {
          // A reload/another tab may already have removed this exact saved
          // copy. Absence satisfies cleanup; it does not imply a new draft.
          token.current = null;
          const memory = getProfileSessionDraft(session, tenant, section);
          if (!live.current.isDirty && memory) {
            const confirmed = await readProfile(http);
            const unchanged =
              getProfileSessionDraft(session, tenant, section) === memory;
            if (
              active() &&
              unchanged &&
              !live.current.isDirty &&
              confirmed.profileVersion !== null &&
              confirmed.profileVersion > (memory.base.profileVersion ?? 0) &&
              sameJson(memory.values, profileSnapshotValues(confirmed))
            )
              setProfileSessionDraft(session, tenant, section, null);
          }
          return;
        }
        if (result.state === "conflict") {
          setState({
            ready: true,
            unresolved: true,
            record: result.record,
            error: null,
          });
          setMessage(
            "Another tab retained a draft. This tab's edits remain in this app session; keep it open while resolving recovery ownership.",
          );
          return;
        }
        token.current = result.record;
        if (isDirty) {
          const retained = getProfileSessionDraft(session, tenant, section);
          if (retained && JSON.stringify(retained.values) === serialized)
            setProfileSessionDraft(session, tenant, section, {
              ...retained,
              durable: true,
            });
        }
        if (!isDirty) {
          setProfileSessionDraft(session, tenant, section, null);
          memoryAtMount.current = undefined;
        }
      })
      .catch((error: unknown) => {
        if (active())
          setState((previous) => ({
            ...previous,
            error:
              error instanceof Error
                ? error
                : new Error("Recovery could not be saved. Keep this app open."),
          }));
      });
  }, [
    base,
    blocked,
    isDirty,
    isSubmitting,
    key,
    ownerId,
    section,
    serialized,
    session,
    storage,
    tenant,
    values,
  ]);

  const memoryData = memoryAtMount.current
    ? {
        version: 2 as const,
        baseProfileVersion: memoryAtMount.current.base.profileVersion,
        changes: safeProfileChanges(
          profileSnapshotValues(memoryAtMount.current.base),
          memoryAtMount.current.values,
        ),
      }
    : null;
  const retainData = memoryData ?? state.record?.data ?? null;
  const restore = async (force: boolean) => {
    if (!retainData) return;
    const memory = memoryAtMount.current;
    const foreignRecord =
      state.record !== null && state.record.ownerId !== ownerId;
    if (foreignRecord && memory) {
      if (!onRestore(retainData, memory, force)) {
        setRestoreConflict(true);
        return;
      }
      setMessage(
        "This tab's retained changes are restored in this app session. The other tab's recovery copy remains intact; retry ownership or explicitly discard that copy before editing.",
      );
      return;
    }
    try {
      const result = await writeDraftSlot(
        storage,
        key,
        profileRecoverySchema,
        state.record,
        ownerId,
        retainData.changes.length ? retainData : null,
      );
      if (result.state === "conflict") {
        setState({
          ready: true,
          unresolved: true,
          record: result.record,
          error: null,
        });
        setMessage(
          "The retained draft changed. Review the current copy before continuing.",
        );
        return;
      }
      token.current = result.record;
      if (!onRestore(retainData, memory, force)) {
        setState({
          ready: true,
          unresolved: true,
          record: result.record,
          error: null,
        });
        setRestoreConflict(true);
        return;
      }
      memoryAtMount.current = undefined;
      setRestoreConflict(false);
      setState({
        ready: true,
        unresolved: false,
        record: result.record,
        error: null,
      });
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error:
          error instanceof Error
            ? error
            : new Error("The draft could not be claimed."),
      }));
    }
  };
  const discard = async () => {
    try {
      const result =
        state.error instanceof UnreadableDraftError
          ? await discardUnreadableDraft(storage, key, state.error)
          : await writeDraftSlot(
              storage,
              key,
              profileRecoverySchema,
              state.record,
              ownerId,
              null,
            ).then((reply) => reply.state === "written");
      if (!result) {
        await load();
        setMessage("The retained copy changed; it has not been removed.");
        return;
      }
      token.current = null;
      const ownMemory = memoryAtMount.current;
      const discardingForeign =
        state.record !== null && state.record.ownerId !== ownerId;
      if (discardingForeign && ownMemory && memoryData) {
        const restored = onRestore(memoryData, ownMemory, false);
        setState({
          ready: true,
          unresolved: !restored,
          record: null,
          error: null,
        });
        setRestoreConflict(!restored);
        setMessage(
          restored
            ? "The other tab's recovery copy was explicitly discarded. This tab's retained changes are preserved."
            : "The other copy was discarded. This tab's retained changes still need review.",
        );
        return;
      }
      memoryAtMount.current = undefined;
      if (!isDirty) setProfileSessionDraft(session, tenant, section, null);
      setState({ ready: true, unresolved: false, record: null, error: null });
      setMessage("");
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The recovery copy could not be removed.",
      );
    }
  };
  const privateDirty = hasPrivateDraftChanges(
    profileSnapshotValues(base),
    values,
  );
  if (!blocked && !message && !privateDirty) return null;
  return (
    <div className="profile-draft-recovery" role="status">
      {!state.ready ? <p>Checking retained Profile changes…</p> : null}
      {state.unresolved ? (
        <>
          <p>
            Unfinished changes are retained for this workspace. Restore them or
            explicitly discard that copy before editing. Another tab's recovery
            copy is never overwritten automatically.
          </p>
          {retainData &&
          (!isDirty ||
            state.record?.ownerId === ownerId ||
            memoryAtMount.current !== undefined) ? (
            <Button
              type="button"
              variant="outline"
              disabled={isSubmitting}
              onClick={() => void restore(false)}
            >
              Restore unfinished Profile changes
            </Button>
          ) : null}
          {restoreConflict ? (
            <>
              <p>
                Saved fields changed after this draft. Review the listed
                conflicts in the Profile status before replacing those field
                values. Credentials from browser recovery are never applied.
              </p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void restore(true)}
              >
                Restore retained field values
              </Button>
            </>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            disabled={isSubmitting}
            onClick={() => void discard()}
          >
            {state.record &&
            state.record.ownerId !== ownerId &&
            (isDirty || memoryAtMount.current !== undefined)
              ? "Discard retained draft from other tab"
              : "Discard saved recovery copy"}
          </Button>
          <Button type="button" variant="outline" onClick={() => void load()}>
            Retry recovery ownership
          </Button>
        </>
      ) : null}
      {state.error ? (
        <>
          <p role="alert">{state.error.message}</p>
          <Button type="button" variant="outline" onClick={() => void load()}>
            Retry recovery read
          </Button>
          {state.error instanceof UnreadableDraftError ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => void discard()}
            >
              Discard unreadable recovery copy
            </Button>
          ) : null}
          {legacyPresent ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                try {
                  storage.remove(legacyKey);
                  void load();
                } catch {
                  setMessage("The older copy could not be removed.");
                }
              }}
            >
              Discard older browser recovery copy
            </Button>
          ) : null}
        </>
      ) : null}
      {privateDirty ? (
        <p>
          Password and credential edits stay only in this app session. Save them
          before reloading or closing the app.
        </p>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
    </div>
  );
}
