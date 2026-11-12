import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { profileKeys } from "../queryKeys.js";

const recoverySchema = z.object({
  ok: z.literal(true),
  profileVersion: z.number().nullable(),
  roles: z.array(
    z.object({
      role_id: z.string(),
      profile_revision: z.number(),
      role: z
        .object({
          title: z.string(),
          company: z.string(),
        })
        .passthrough(),
    }),
  ),
  achievements: z.array(
    z.object({
      role_id: z.string(),
      achievement_id: z.string(),
      profile_revision: z.number(),
      text: z.string(),
    }),
  ),
});

export function ProfileRecoveryPanel({
  disabled,
}: {
  readonly disabled: boolean;
}) {
  const { http } = usePorts();
  const tenant = useTenantId();
  const client = useQueryClient();
  const key = [...profileKeys.all(tenant), "recovery"];
  const recovery = useQuery({
    queryKey: key,
    queryFn: async () =>
      recoverySchema.parse(
        await http.json<unknown>("GET", "/v1/profile/recovery"),
      ),
  });
  const restore = useMutation({
    mutationFn: async (item: {
      kind: "role" | "achievement";
      id: string;
      sourceProfileVersion: number;
    }) => {
      const path = "/v1/profile/recovery/restore";
      const response = await http.json<unknown>("POST", path, {
        body: {
          ...item,
          expectedProfileVersion: recovery.data?.profileVersion,
        },
      });
      const parsed = z
        .object({
          ok: z.literal(true),
          profileVersion: z.number(),
          profile: z.record(z.string(), z.unknown()),
        })
        .passthrough()
        .safeParse(response);
      if (!parsed.success)
        throw createUnconfirmedWriteError(
          "POST",
          path,
          new Error(
            "The restoration response could not be verified. Refresh the saved Profile before retrying.",
          ),
        );
      return parsed.data;
    },
    onSuccess: () =>
      client.invalidateQueries({ queryKey: profileKeys.all(tenant) }),
  });
  if (
    !recovery.data?.roles.length &&
    !recovery.data?.achievements.length &&
    !recovery.error
  )
    return null;
  return (
    <details className="profile-recovery">
      <summary>Restore removed experience</summary>
      <p>
        Restore a role or achievement with its original identity and retained
        wording. Save current edits first.
      </p>
      {recovery.error ? <p role="alert">{recovery.error.message}</p> : null}
      <ul>
        {recovery.data?.roles.map((item) => (
          <li key={item.role_id}>
            <span>
              {item.role.title} · {item.role.company}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || restore.isPending}
              onClick={() =>
                restore.mutate({
                  kind: "role",
                  id: item.role_id,
                  sourceProfileVersion: item.profile_revision,
                })
              }
            >
              Restore role
            </Button>
          </li>
        ))}
        {recovery.data?.achievements.map((item) => (
          <li key={item.achievement_id}>
            <span>{item.text}</span>
            <Button
              type="button"
              variant="outline"
              disabled={disabled || restore.isPending}
              onClick={() =>
                restore.mutate({
                  kind: "achievement",
                  id: item.achievement_id,
                  sourceProfileVersion: item.profile_revision,
                })
              }
            >
              Restore achievement
            </Button>
          </li>
        ))}
      </ul>
      {restore.error ? (
        <p role="alert">
          {restore.error.message} Current Profile and accepted resumes remain
          available.
        </p>
      ) : null}
      {restore.error || recovery.error ? (
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void client.invalidateQueries({ queryKey: profileKeys.all(tenant) })
          }
        >
          Refresh saved Profile
        </Button>
      ) : null}
      {restore.isSuccess ? <p role="status">Experience restored.</p> : null}
    </details>
  );
}
