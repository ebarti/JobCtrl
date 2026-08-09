import type { FastifyInstance, FastifyReply } from "fastify";
import type { ZodType } from "zod";

import {
  ENDPOINTS,
  type EndpointDispatchContext,
  type EndpointFailureResponse,
  type EndpointHttpMethod,
  type EndpointPath,
  type EndpointPathParam,
  type EndpointRequest,
  type EndpointResponse,
  type EndpointSpec,
  type JsonRpcError,
  type RpcMethod,
} from "./contracts.js";
import type { JsonRpcDispatcher } from "./json-rpc-adapter.js";

type DirectEndpoint = EndpointSpec extends infer TEndpoint
  ? TEndpoint extends EndpointSpec
    ? Exclude<TEndpoint["dispatch"], undefined> extends never
      ? TEndpoint
      : never
    : never
  : never;

export type DirectEndpointHandlers = {
  [TEndpoint in DirectEndpoint as TEndpoint["name"]]: (
    input: {
      readonly request: EndpointRequest<TEndpoint>;
      readonly pathParam: EndpointPathParam<TEndpoint>;
    },
    reply: FastifyReply,
  ) => EndpointResponse<TEndpoint> | unknown | Promise<EndpointResponse<TEndpoint> | unknown>;
};

export type EndpointRequestParser = <T>(
  reply: { code: (statusCode: number) => unknown },
  schema: ZodType<T>,
  body: unknown,
) => T | null;

export interface RegisterEndpointRoutesDependencies {
  readonly dispatcher: JsonRpcDispatcher;
  readonly dispatchContext: EndpointDispatchContext;
  readonly handlers: DirectEndpointHandlers;
  readonly parseBody: EndpointRequestParser;
}

interface RuntimeDispatch {
  readonly rpcMethod: RpcMethod;
  readonly params: (
    input: { readonly request: unknown; readonly pathParam: unknown },
    context: EndpointDispatchContext,
  ) => unknown;
  readonly paramsSchema: ZodType;
  readonly result: ZodType;
  readonly response: (input: {
    readonly request: unknown;
    readonly pathParam: unknown;
    readonly result: unknown;
  }) => unknown | null;
  readonly error: (failure:
    | { readonly kind: "transport" }
    | { readonly kind: "rpc"; readonly error: JsonRpcError }
    | { readonly kind: "invalid_result" }) => EndpointFailureResponse;
}

interface RuntimeEndpoint {
  readonly name: string;
  readonly method: EndpointHttpMethod;
  readonly path: string | EndpointPath<unknown, string>;
  readonly request: ZodType;
  readonly response: ZodType;
  readonly dispatch?: RuntimeDispatch;
}

export function registerEndpointRoutes(
  app: FastifyInstance,
  dependencies: RegisterEndpointRoutesDependencies,
): void {
  for (const endpoint of Object.values(ENDPOINTS) as unknown as RuntimeEndpoint[]) {
    app.route({
      method: endpoint.method,
      url: typeof endpoint.path === "string" ? endpoint.path : endpoint.path.route,
      handler: async (request, reply) => {
        const parsedRequest = dependencies.parseBody(
          reply,
          endpoint.request,
          endpoint.method === "GET" ? request.query : (request.body ?? {}),
        );
        if (parsedRequest === null) {
          return undefined;
        }

        const parsedPathParam = parsePathParam(endpoint, request.params, reply);
        if (!parsedPathParam.ok) {
          return parsedPathParam.response;
        }
        const pathParam = parsedPathParam.value;

        if (!endpoint.dispatch) {
          const handler = dependencies.handlers[
            endpoint.name as keyof DirectEndpointHandlers
          ] as (
            input: { readonly request: unknown; readonly pathParam: unknown },
            reply: FastifyReply,
          ) => unknown | Promise<unknown>;
          const response = await handler(
            { request: parsedRequest, pathParam },
            reply,
          );
          return isFailurePayload(response)
            ? response
            : endpoint.response.parse(response);
        }

        const dispatch = endpoint.dispatch;
        let rpcResponse;
        try {
          const params = dispatch.paramsSchema.parse(
            dispatch.params(
              { request: parsedRequest, pathParam },
              dependencies.dispatchContext,
            ),
          ) as Record<string, unknown>;
          rpcResponse = await dependencies.dispatcher.call(dispatch.rpcMethod, params);
        } catch {
          return endpointFailure(reply, dispatch.error({ kind: "transport" }));
        }
        if (rpcResponse.error) {
          return endpointFailure(
            reply,
            dispatch.error({ kind: "rpc", error: rpcResponse.error }),
          );
        }

        const result = dispatch.result.safeParse(rpcResponse.result);
        if (!result.success) {
          return endpointFailure(reply, dispatch.error({ kind: "invalid_result" }));
        }
        const response = dispatch.response({
          request: parsedRequest,
          pathParam,
          result: result.data,
        });
        const parsedResponse = endpoint.response.safeParse(response);
        if (response === null || !parsedResponse.success) {
          return endpointFailure(reply, dispatch.error({ kind: "invalid_result" }));
        }
        return parsedResponse.data;
      },
    });
  }
}

function parsePathParam(
  endpoint: RuntimeEndpoint,
  requestParams: unknown,
  reply: FastifyReply,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly response: unknown } {
  if (typeof endpoint.path === "string") {
    return { ok: true, value: undefined };
  }
  const params = isRecord(requestParams) ? requestParams : {};
  const rawParam = params[endpoint.path.paramName];
  const parsed = endpoint.path.paramSchema.safeParse(
    decodeRouteParam(typeof rawParam === "string" ? rawParam : ""),
  );
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  return {
    ok: false,
    response: endpointFailure(reply, endpoint.path.invalid),
  };
}

function endpointFailure(reply: FastifyReply, failure: EndpointFailureResponse) {
  void reply.code(failure.status);
  return {
    ok: false as const,
    error: failure.error,
    ...(failure.message === undefined ? {} : { message: failure.message }),
  };
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isFailurePayload(value: unknown): boolean {
  return isRecord(value) && value.ok === false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
