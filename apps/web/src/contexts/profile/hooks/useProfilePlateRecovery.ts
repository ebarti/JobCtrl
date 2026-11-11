import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { Value } from "platejs";
import { isPlateValue } from "../../materials/index.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  readDraftSlot,
  writeDraftSlot,
  discardUnreadableDraft,
  UnreadableDraftError,
  type DraftSlotToken,
  type OwnedDraft,
} from "../lib/owned-draft-slot.js";
import {
  profileDraftGeneration,
  getProfilePlateSessionDraft,
  setProfilePlateSessionDraft,
} from "../lib/profile-draft-state.js";

const plateSchema = z
  .object({
    profileVersion: z.number().nullable(),
    value: z.custom<Value>(
      (value) =>
        isPlateValue(value) &&
        value.length > 0 &&
        value.every(
          (node) =>
            typeof node === "object" &&
            node !== null &&
            "children" in node &&
            Array.isArray(node.children),
        ),
      "The retained document requires block roots and valid nested nodes.",
    ),
  })
  .strict();
type PlateData = z.infer<typeof plateSchema>;
export function useProfilePlateRecovery(
  profileVersion: number | null | undefined,
) {
  const { storage, session, requestIdentity } = usePorts();
  const tenant = useTenantId();
  const key = `profile-resume-draft:v2:${tenant}`,
    legacyKey = `profile-resume-draft:v1:${tenant}`;
  const initialMemory = useRef(getProfilePlateSessionDraft(session, tenant));
  const owner = useRef(
    initialMemory.current?.ownerId ?? requestIdentity.create(),
  ).current;
  const generation = useRef(profileDraftGeneration(session)).current;
  const active = () => generation === profileDraftGeneration(session);
  const sourcePin = useRef<number | null | undefined>(undefined),
    token = useRef<DraftSlotToken | null>(null);
  const writes = useRef(Promise.resolve()),
    edited = useRef(false),
    legacyRaw = useRef<string | null>(null);
  const latest = useRef<PlateData | null>(null);
  const [state, setState] = useState<{
    ready: boolean;
    pending: boolean;
    record: OwnedDraft<PlateData> | null;
    error: Error | null;
  }>({ ready: false, pending: false, record: null, error: null });
  const [initialDraftValue, setInitialDraftValue] = useState<Value | null>(
    null,
  );
  const [restoredVersion, setRestoredVersion] = useState<
    number | null | undefined
  >(undefined);
  const load = async () => {
    try {
      let record = await readDraftSlot(storage, key, plateSchema);
      legacyRaw.current = storage.readRaw?.(legacyKey) ?? null;
      if (legacyRaw.current !== null) {
        let value: unknown;
        try {
          value = JSON.parse(legacyRaw.current);
        } catch {
          throw new Error(
            "The older resume recovery copy could not be read. Retry or explicitly discard that copy.",
          );
        }
        const legacy = plateSchema.safeParse(value);
        if (!legacy.success)
          throw new Error(
            "The older resume recovery copy has invalid document nodes. Retry or explicitly discard it before editing.",
          );
        if (record)
          throw new Error(
            "An older resume recovery copy also exists. Resolve the current copy before removing the older one.",
          );
        const migrated = await writeDraftSlot(
          storage,
          key,
          plateSchema,
          null,
          owner,
          legacy.data,
        );
        if (migrated.state === "conflict")
          throw new Error(
            "Another tab retained a resume draft during migration. Retry before editing.",
          );
        record = migrated.record;
        if (storage.readRaw?.(legacyKey) !== legacyRaw.current)
          throw new Error(
            "The older resume draft changed during migration. Its current copy is retained.",
          );
        storage.remove(legacyKey);
        legacyRaw.current = null;
      }
      if (!active()) return;
      const stillOwned =
        edited.current &&
        (!record ||
          (record.ownerId === owner &&
            token.current?.revision === record.revision));
      token.current = stillOwned ? record : null;
      setState({
        ready: true,
        pending:
          !stillOwned &&
          (record !== null || initialMemory.current !== undefined),
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
              : new Error("Resume recovery storage is unavailable."),
        }));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const pending = !state.ready || state.pending || state.error !== null;
  const enqueue = (data: PlateData) => {
    writes.current = writes.current
      .then(async () => {
        if (!active()) return;
        const result = await writeDraftSlot(
          storage,
          key,
          plateSchema,
          token.current,
          owner,
          data,
        );
        if (!active()) return;
        if (result.state === "conflict") {
          setState({
            ready: true,
            pending: true,
            record: result.record,
            error: null,
          });
          return;
        }
        token.current = result.record;
        const memory = getProfilePlateSessionDraft(session, tenant);
        if (
          memory &&
          memory.profileVersion === data.profileVersion &&
          JSON.stringify(memory.value) === JSON.stringify(data.value)
        )
          setProfilePlateSessionDraft(session, tenant, {
            ...memory,
            durable: true,
          });
      })
      .catch((error: unknown) => {
        if (active())
          setState((previous) => ({
            ...previous,
            error:
              error instanceof Error
                ? error
                : new Error(
                    "The resume draft could not be retained. Keep this page open.",
                  ),
          }));
      });
  };
  const retain = (value: Value) => {
    const data = {
      profileVersion:
        sourcePin.current === undefined
          ? (profileVersion ?? null)
          : sourcePin.current,
      value,
    };
    latest.current = data;
    edited.current = true;
    setProfilePlateSessionDraft(session, tenant, {
      ownerId: owner,
      ...data,
      durable: false,
    });
    if (!pending) enqueue(data);
  };
  const showDraft = (data: PlateData) => {
    latest.current = data;
    edited.current = true;
    sourcePin.current = data.profileVersion;
    setInitialDraftValue(data.value);
    setRestoredVersion(data.profileVersion);
  };
  const restore = async () => {
    const memory = getProfilePlateSessionDraft(session, tenant);
    const data = memory
      ? { profileVersion: memory.profileVersion, value: memory.value }
      : state.record?.data;
    if (!data) return;
    if (memory && state.record && state.record.ownerId !== owner) {
      showDraft(data);
      return;
    }
    try {
      const result = await writeDraftSlot(
        storage,
        key,
        plateSchema,
        state.record,
        owner,
        data,
      );
      if (result.state === "conflict") {
        setState({
          ready: true,
          pending: true,
          record: result.record,
          error: null,
        });
        return;
      }
      token.current = result.record;
      showDraft(data);
      initialMemory.current = undefined;
      setProfilePlateSessionDraft(session, tenant, {
        ownerId: owner,
        ...data,
        durable: true,
      });
      setState({
        ready: true,
        pending: false,
        record: result.record,
        error: null,
      });
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error:
          error instanceof Error
            ? error
            : new Error("The resume draft could not be restored."),
      }));
    }
  };
  const discard = async (): Promise<boolean> => {
    try {
      if (legacyRaw.current !== null) {
        if (storage.readRaw?.(legacyKey) !== legacyRaw.current) {
          await load();
          return false;
        }
        storage.remove(legacyKey);
        legacyRaw.current = null;
        await load();
        return false;
      }
      const foreign = state.record !== null && state.record.ownerId !== owner;
      const memory = getProfilePlateSessionDraft(session, tenant);
      const cleared =
        state.error instanceof UnreadableDraftError
          ? await discardUnreadableDraft(storage, key, state.error)
          : await writeDraftSlot(
              storage,
              key,
              plateSchema,
              state.pending ? state.record : token.current,
              owner,
              null,
            ).then((result) => result.state === "written");
      if (!cleared) {
        await load();
        return false;
      }
      token.current = null;
      if (foreign && memory) {
        const data = {
          profileVersion: memory.profileVersion,
          value: memory.value,
        };
        showDraft(data);
        initialMemory.current = undefined;
        setState({ ready: true, pending: false, record: null, error: null });
        enqueue(data);
        return false;
      }
      latest.current = null;
      edited.current = false;
      initialMemory.current = undefined;
      setProfilePlateSessionDraft(session, tenant, null);
      setInitialDraftValue(null);
      sourcePin.current = undefined;
      setRestoredVersion(undefined);
      setState({ ready: true, pending: false, record: null, error: null });
      return true;
    } catch (error) {
      setState((previous) => ({
        ...previous,
        error:
          error instanceof Error
            ? error
            : new Error("The retained resume copy could not be removed."),
      }));
      return false;
    }
  };
  return {
    pending,
    initialDraftValue,
    restoredVersion,
    error: state.error?.message ?? null,
    hasRetainedDraft:
      state.record !== null || initialMemory.current !== undefined,
    hasLocalEdits: edited.current,
    restore,
    discard,
    retry: load,
    retain,
  };
}
