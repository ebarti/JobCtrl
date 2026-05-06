export interface FeatureFlagPort {
  get<T extends boolean | number | string>(key: string, defaultValue: T): T;
}
