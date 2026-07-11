import { cleanupExpiredData } from "../src/database.js";
import { logEdgeEvent } from "../src/http.js";

interface ScheduledControllerLike {
  scheduledTime: number;
}

export async function runRetention(env: DemoEdgeEnv, now: Date): Promise<void> {
  const deleted = await cleanupExpiredData(env, now);
  logEdgeEvent("retention", {
    outcome: "completed",
    operationalCounters: deleted.operationalCounters,
    retryDigests: deleted.retryDigests,
    productEvents: deleted.productEvents,
    sessionRates: deleted.sessionRates,
    globalTelemetryRates: deleted.globalTelemetryRates,
    operationalRates: deleted.operationalRates,
    activeIdentities: deleted.activeIdentities,
  });
}

export default {
  async scheduled(controller: ScheduledControllerLike, env: DemoEdgeEnv): Promise<void> {
    try {
      await runRetention(env, new Date(controller.scheduledTime));
    } catch {
      logEdgeEvent("retention", { outcome: "failed" });
      throw new Error("retention_failed");
    }
  },
};
