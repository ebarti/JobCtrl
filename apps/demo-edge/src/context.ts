export interface DemoRequestContext {
  request: Request;
  env: DemoEdgeEnv;
  ingressAllowed: boolean;
}
