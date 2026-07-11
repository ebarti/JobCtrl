import {
  handleConsentGet,
  handleConsentPost,
  handleHealthPost,
  handleTelemetryPost,
} from "../src/handlers.js";
import { sha256 } from "../src/crypto.js";
import type { DemoRequestContext } from "../src/context.js";

export type DemoApiRouteClass = "consent" | "health" | "telemetry" | "unknown";

export function classifyDemoApiRoute(pathname: string): DemoApiRouteClass {
  switch (pathname) {
    case "/api/demo-consent":
      return "consent";
    case "/api/demo-health":
      return "health";
    case "/api/demo-telemetry":
      return "telemetry";
    default:
      return "unknown";
  }
}

export async function ingressRateLimitKey(clientIp: string, pathname: string): Promise<string> {
  return sha256(`${clientIp}\u0000${classifyDemoApiRoute(pathname)}`);
}

async function ingressRequestAllowed(request: Request, env: DemoEdgeEnv): Promise<boolean> {
  const clientIp = request.headers.get("cf-connecting-ip");
  if (clientIp === null) return false;
  try {
    const path = new URL(request.url).pathname;
    // The raw address and ephemeral digest never enter D1 or application logs.
    const key = await ingressRateLimitKey(clientIp, path);
    return (await env.PUBLIC_INGRESS_LIMITER.limit({ key })).success;
  } catch {
    return false;
  }
}

export async function dispatchDemoApi(request: Request, env: DemoEdgeEnv): Promise<Response> {
  const routeClass = classifyDemoApiRoute(new URL(request.url).pathname);
  const context: DemoRequestContext = {
    request,
    env,
    ingressAllowed: await ingressRequestAllowed(request, env),
  };
  switch (routeClass) {
    case "consent":
      return request.method === "GET" ? handleConsentGet(context) : handleConsentPost(context);
    case "health":
      return handleHealthPost(context);
    case "telemetry":
      return handleTelemetryPost(context);
    case "unknown":
      return new Response(null, { status: 404 });
  }
}

export default {
  fetch: dispatchDemoApi,
};
