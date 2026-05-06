import type { FeatureFlagPort } from "../../ports/FeatureFlagPort.js";

export class StaticFeatureFlagAdapter implements FeatureFlagPort {
  get<T extends boolean | number | string>(_key: string, defaultValue: T): T {
    return defaultValue;
  }
}
