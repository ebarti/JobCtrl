import { z } from "zod";

import {
  IsoTimestampSchema,
  LearningPaginationQuerySchema,
  LearningRecommendationIdSchema,
  LearningRecommendationReviewIdSchema,
  LearningRecommendationSummarySchema,
  TailoringPolicyLearnedRuleSchema,
} from "./schemas.js";
import {
  JsonRpcErrorCodes,
  ReviewLearningRecommendationParamsSchema,
  ReviewLearningRecommendationResultSchema,
  RollbackTailoringPolicyParamsSchema,
  RollbackTailoringPolicyResultSchema,
  RpcMethods,
  type JsonRpcError,
  type RpcMethod,
} from "./rpc.js";

export const ENDPOINT_HTTP_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;
export type EndpointHttpMethod = (typeof ENDPOINT_HTTP_METHODS)[number];

export const ENDPOINT_DEMO_CAPABILITY_CLASSES = [
  "browser_local",
  "simulated_async",
  "rehearsed_external",
  "unavailable",
] as const;
export type EndpointDemoCapabilityClass =
  (typeof ENDPOINT_DEMO_CAPABILITY_CLASSES)[number];

export interface EndpointDemoCapability {
  readonly class: EndpointDemoCapabilityClass;
  readonly reason: string;
}

export interface EndpointFailureResponse {
  readonly status: number;
  readonly error: string;
  readonly message?: string;
}

export type EndpointDispatchFailure =
  | { readonly kind: "transport" }
  | { readonly kind: "rpc"; readonly error: JsonRpcError }
  | { readonly kind: "invalid_result" };

export interface EndpointDispatchContext {
  readonly tenantId: string;
  readonly appDir: string;
  readonly dbPath: string;
}

export interface EndpointPath<TParam, TParamName extends string> {
  (param: TParam): string;
  readonly route: string;
  readonly paramName: TParamName;
  readonly paramSchema: z.ZodType<TParam>;
  readonly invalid: EndpointFailureResponse;
}

export function defineEndpointPath<const TParamName extends string, TParam>(options: {
  readonly route: string;
  readonly paramName: TParamName;
  readonly paramSchema: z.ZodType<TParam>;
  readonly invalid: EndpointFailureResponse;
  readonly build: (param: TParam) => string;
}): EndpointPath<TParam, TParamName> {
  return Object.assign(options.build, {
    route: options.route,
    paramName: options.paramName,
    paramSchema: options.paramSchema,
    invalid: options.invalid,
  });
}

type AnySchema = z.ZodType;
type AnyEndpointPath = string | EndpointPath<any, string>;

export interface RpcEndpointDispatch<
  TRequestSchema extends AnySchema,
  TPathParam,
  TRpcParamsSchema extends AnySchema,
  TRpcResultSchema extends AnySchema,
> {
  readonly rpcMethod: RpcMethod;
  readonly params: (
    input: {
      readonly request: z.output<TRequestSchema>;
      readonly pathParam: TPathParam;
    },
    context: EndpointDispatchContext,
  ) => z.input<TRpcParamsSchema>;
  readonly paramsSchema: TRpcParamsSchema;
  readonly result: TRpcResultSchema;
  readonly response: (input: {
    readonly request: z.output<TRequestSchema>;
    readonly pathParam: TPathParam;
    readonly result: z.output<TRpcResultSchema>;
  }) => unknown | null;
  readonly error: (failure: EndpointDispatchFailure) => EndpointFailureResponse;
}

interface EndpointDefinitionBase<
  TName extends string,
  TMethod extends EndpointHttpMethod,
  TPath extends AnyEndpointPath,
  TRequestSchema extends AnySchema,
  TResponseSchema extends AnySchema,
> {
  readonly name: TName;
  readonly method: TMethod;
  readonly path: TPath;
  readonly request: TRequestSchema;
  readonly response: TResponseSchema;
  readonly demo: EndpointDemoCapability;
}

export type EndpointDefinition<
  TName extends string,
  TMethod extends EndpointHttpMethod,
  TPath extends AnyEndpointPath,
  TRequestSchema extends AnySchema,
  TResponseSchema extends AnySchema,
  TDispatch = undefined,
> = EndpointDefinitionBase<
  TName,
  TMethod,
  TPath,
  TRequestSchema,
  TResponseSchema
> &
  ([TDispatch] extends [undefined]
    ? { readonly dispatch?: never }
    : { readonly dispatch: TDispatch });

export function defineEndpoint<
  const TName extends string,
  const TMethod extends EndpointHttpMethod,
  const TPath extends AnyEndpointPath,
  TRequestSchema extends AnySchema,
  TResponseSchema extends AnySchema,
  const TDispatch = undefined,
>(
  definition: EndpointDefinition<
    TName,
    TMethod,
    TPath,
    TRequestSchema,
    TResponseSchema,
    TDispatch
  >,
): EndpointDefinition<
  TName,
  TMethod,
  TPath,
  TRequestSchema,
  TResponseSchema,
  TDispatch
> {
  return definition;
}

export const LearningRecommendationListQuerySchema = LearningPaginationQuerySchema;
export type LearningRecommendationListQuery = z.output<
  typeof LearningPaginationQuerySchema
>;

const LearningRecommendationsRequestSchema =
  LearningRecommendationListQuerySchema.optional().transform(
    (query) => query ?? LearningRecommendationListQuerySchema.parse({}),
  );

export const LearningRecommendationListResponseSchema = z
  .object({
    ok: z.literal(true),
    recommendations: z.array(LearningRecommendationSummarySchema).max(100),
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1).max(100),
    total: z.number().int().nonnegative(),
    totalPages: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => value.recommendations.length <= value.pageSize,
    "Recommendation page exceeds its declared page size.",
  );
export type LearningRecommendationListResponse = z.infer<
  typeof LearningRecommendationListResponseSchema
>;

export const LearningRecommendationReviewRequestSchema = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accepted") }).strict(),
  z.object({ decision: z.literal("rejected") }).strict(),
]);
export type LearningRecommendationReviewRequest = z.infer<
  typeof LearningRecommendationReviewRequestSchema
>;

const LearningRecommendationReviewResponseBaseSchema = z
  .object({
    ok: z.literal(true),
    reviewId: LearningRecommendationReviewIdSchema,
    recommendationId: LearningRecommendationIdSchema,
    revision: z.number().int().positive(),
    context: z.literal("materials"),
    policyKind: z.literal("tailoring_rule"),
    reviewedAt: IsoTimestampSchema,
  })
  .strict();

export const LearningRecommendationReviewResponseSchema = z.discriminatedUnion("decision", [
  LearningRecommendationReviewResponseBaseSchema.extend({
    decision: z.literal("accepted"),
    policyVersion: z.number().int().positive(),
  }),
  LearningRecommendationReviewResponseBaseSchema.extend({
    decision: z.literal("rejected"),
    policyVersion: z.null(),
  }),
]);
export type LearningRecommendationReviewResponse = z.infer<
  typeof LearningRecommendationReviewResponseSchema
>;

export const TailoringPolicyRollbackRequestSchema = z
  .object({ targetVersion: z.number().int().positive() })
  .strict();
export type TailoringPolicyRollbackRequest = z.infer<
  typeof TailoringPolicyRollbackRequestSchema
>;

export const TailoringPolicyRollbackResponseSchema = z
  .object({
    ok: z.literal(true),
    context: z.literal("materials"),
    policyKind: z.literal("tailoring_rule"),
    version: z.number().int().positive(),
    status: z.literal("current"),
    learnedRules: z.array(TailoringPolicyLearnedRuleSchema).max(5),
    sourceReviewId: z.null(),
    sourceRecommendationId: z.null(),
    rollbackOfVersion: z.number().int().positive(),
    rollbackReasonCode: z.literal("user_requested"),
    createdAt: IsoTimestampSchema,
  })
  .strict();
export type TailoringPolicyRollbackResponse = z.infer<
  typeof TailoringPolicyRollbackResponseSchema
>;

const recommendationReviewPath = defineEndpointPath({
  route: "/v1/learning/recommendations/:recommendationId/reviews",
  paramName: "recommendationId",
  paramSchema: LearningRecommendationIdSchema,
  invalid: {
    status: 400,
    error: "invalid_learning_recommendation_id",
  },
  build: (recommendationId: string) =>
    `/v1/learning/recommendations/${encodeURIComponent(recommendationId)}/reviews`,
});

const reviewFailure = (failure: EndpointDispatchFailure): EndpointFailureResponse => ({
  status:
    failure.kind === "transport"
      ? 503
      : failure.kind === "rpc" && failure.error.code === JsonRpcErrorCodes.InvalidParams
        ? 409
        : 502,
  error: "learning_recommendation_review_failed",
  message: "The learning recommendation review could not be completed.",
});

const rollbackFailure = (failure: EndpointDispatchFailure): EndpointFailureResponse => ({
  status:
    failure.kind === "transport"
      ? 503
      : failure.kind === "rpc" && failure.error.code === JsonRpcErrorCodes.InvalidParams
        ? 409
        : 502,
  error: "tailoring_policy_rollback_failed",
  message: "The tailoring policy rollback could not be completed.",
});

export const ENDPOINTS = {
  learningRecommendations: defineEndpoint({
    name: "learningRecommendations",
    method: "GET",
    path: "/v1/learning/recommendations",
    request: LearningRecommendationsRequestSchema,
    response: LearningRecommendationListResponseSchema,
    demo: {
      class: "unavailable",
      reason: "Learning recommendations require the local audited database.",
    },
  }),
  reviewLearningRecommendation: defineEndpoint({
    name: "reviewLearningRecommendation",
    method: "POST",
    path: recommendationReviewPath,
    request: LearningRecommendationReviewRequestSchema,
    response: LearningRecommendationReviewResponseSchema,
    dispatch: {
      rpcMethod: RpcMethods.ReviewLearningRecommendation,
      params: ({ request, pathParam }, context) => ({
        tenantId: context.tenantId,
        recommendationId: pathParam,
        decision: request.decision,
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
      }),
      paramsSchema: ReviewLearningRecommendationParamsSchema,
      result: ReviewLearningRecommendationResultSchema,
      response: ({ request, pathParam, result }) => {
        if (
          result.recommendationId !== pathParam ||
          result.decision !== request.decision
        ) {
          return null;
        }
        const { status: _status, ...review } = result;
        return { ok: true, ...review };
      },
      error: reviewFailure,
    } satisfies RpcEndpointDispatch<
      typeof LearningRecommendationReviewRequestSchema,
      string,
      typeof ReviewLearningRecommendationParamsSchema,
      typeof ReviewLearningRecommendationResultSchema
    >,
    demo: {
      class: "unavailable",
      reason: "Learning recommendation review requires the local audited database.",
    },
  }),
  rollbackTailoringPolicy: defineEndpoint({
    name: "rollbackTailoringPolicy",
    method: "POST",
    path: "/v1/learning/policies/materials/rollbacks",
    request: TailoringPolicyRollbackRequestSchema,
    response: TailoringPolicyRollbackResponseSchema,
    dispatch: {
      rpcMethod: RpcMethods.RollbackTailoringPolicy,
      params: ({ request }, context) => ({
        tenantId: context.tenantId,
        targetVersion: request.targetVersion,
        expectedAppDir: context.appDir,
        expectedDbPath: context.dbPath,
      }),
      paramsSchema: RollbackTailoringPolicyParamsSchema,
      result: RollbackTailoringPolicyResultSchema,
      response: ({ request, result }) =>
        result.rollbackOfVersion === request.targetVersion
          ? {
              ok: true,
              context: result.context,
              policyKind: result.policyKind,
              version: result.policyVersion,
              status: "current",
              learnedRules: result.learnedRules,
              sourceReviewId: null,
              sourceRecommendationId: null,
              rollbackOfVersion: result.rollbackOfVersion,
              rollbackReasonCode: result.rollbackReasonCode,
              createdAt: result.rolledBackAt,
            }
          : null,
      error: rollbackFailure,
    } satisfies RpcEndpointDispatch<
      typeof TailoringPolicyRollbackRequestSchema,
      undefined,
      typeof RollbackTailoringPolicyParamsSchema,
      typeof RollbackTailoringPolicyResultSchema
    >,
    demo: {
      class: "unavailable",
      reason: "Tailoring policy rollback requires the local audited database.",
    },
  }),
} as const;

export type EndpointRegistry = typeof ENDPOINTS;
export type EndpointSpec = EndpointRegistry[keyof EndpointRegistry];

export type EndpointByName<TName extends EndpointSpec["name"]> = Extract<
  EndpointSpec,
  { readonly name: TName }
>;

export type EndpointRequest<TEndpoint extends EndpointSpec> = z.output<
  TEndpoint["request"]
>;
export type EndpointRequestInput<TEndpoint extends EndpointSpec> = z.input<
  TEndpoint["request"]
>;
export type EndpointResponse<TEndpoint extends EndpointSpec> = z.output<
  TEndpoint["response"]
>;
export type EndpointPathParam<TEndpoint extends EndpointSpec> =
  TEndpoint["path"] extends EndpointPath<infer TParam, string> ? TParam : undefined;

type EndpointPathArguments<TEndpoint extends EndpointSpec> =
  TEndpoint["path"] extends EndpointPath<infer TParam, string>
    ? readonly [pathParam: TParam]
    : readonly [];

type EndpointRequestArguments<TEndpoint extends EndpointSpec> =
  undefined extends EndpointRequestInput<TEndpoint>
    ? readonly [request?: Exclude<EndpointRequestInput<TEndpoint>, undefined>]
    : readonly [request: EndpointRequestInput<TEndpoint>];

export type EndpointClientMethod<TEndpoint extends EndpointSpec> = (
  ...args: [
    ...EndpointPathArguments<TEndpoint>,
    ...EndpointRequestArguments<TEndpoint>,
  ]
) => Promise<EndpointResponse<TEndpoint>>;

export type EndpointClientMethods = {
  [TEndpoint in EndpointSpec as TEndpoint["name"]]: EndpointClientMethod<TEndpoint>;
};

export const ENDPOINT_SPEC_FIXTURE_SCHEMA_VERSION = 1 as const;

export function endpointSpecJsonSchemaFixture() {
  return {
    schemaVersion: ENDPOINT_SPEC_FIXTURE_SCHEMA_VERSION,
    endpoints: Object.fromEntries(
      Object.values(ENDPOINTS).map((endpoint) => [
        endpoint.name,
        {
          request: z.toJSONSchema(endpoint.request, {
            io: "input",
            unrepresentable: "any",
          }),
          response: z.toJSONSchema(endpoint.response, {
            io: "input",
            unrepresentable: "any",
          }),
        },
      ]),
    ),
  };
}
