import {
  ENDPOINTS,
  type EndpointClientMethods,
  type EndpointHttpMethod,
} from "@jobctrl/contracts";

export type EndpointTransport = (
  method: EndpointHttpMethod,
  path: string,
  request: unknown,
) => Promise<unknown>;

export function createEndpointMethods(
  transport: EndpointTransport,
): EndpointClientMethods {
  const methods: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const endpoint of Object.values(ENDPOINTS)) {
    methods[endpoint.name] = async (...args: unknown[]) => {
      const hasPathParam = typeof endpoint.path === "function";
      const path = hasPathParam
        ? (endpoint.path as (param: unknown) => string)(args[0])
        : endpoint.path;
      const request = args[hasPathParam ? 1 : 0];
      const response = await transport(endpoint.method, path, request);
      return endpoint.response.parse(response);
    };
  }
  return methods as EndpointClientMethods;
}

export function createEndpointDelegates(
  client: EndpointClientMethods,
): EndpointClientMethods {
  const delegates: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const endpoint of Object.values(ENDPOINTS)) {
    const method = client[endpoint.name] as (...args: unknown[]) => Promise<unknown>;
    delegates[endpoint.name] = (...args) => method.apply(client, args);
  }
  return delegates as EndpointClientMethods;
}
