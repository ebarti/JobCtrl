import { describe, expect, it } from "vitest";

import {
  buildClaudeCredentialBatch,
  buildGoogleCredentialBatch,
  removeClaudeProviderBatch,
  removeGoogleProviderBatch,
  type ClaudeMode,
} from "./provider-credential-plans.js";

const claudeBase = {
  apiKey: "sk-ant-test",
  vertexProjectId: "project-id",
  vertexRegion: "global",
  awsRegion: "us-east-1",
  awsProfile: "jobctrl",
  awsWorkspaceId: "wrkspc_test",
  foundryResource: "claude-resource",
};

describe("provider credential plans", () => {
  it.each([
    ["anthropic_api_key", ["ANTHROPIC_API_KEY"]],
    ["vertex", ["CLAUDE_CODE_USE_VERTEX", "ANTHROPIC_VERTEX_PROJECT_ID", "CLOUD_ML_REGION"]],
    ["bedrock", ["CLAUDE_CODE_USE_BEDROCK", "AWS_REGION", "AWS_PROFILE"]],
    [
      "anthropic_aws",
      ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "ANTHROPIC_AWS_WORKSPACE_ID", "AWS_REGION", "AWS_PROFILE"],
    ],
    ["foundry", ["CLAUDE_CODE_USE_FOUNDRY", "ANTHROPIC_FOUNDRY_RESOURCE"]],
  ] satisfies ReadonlyArray<readonly [ClaudeMode, readonly string[]]>)(
    "sets only the selected Claude %s route and deletes every conflicting route",
    (mode, expectedSetKeys) => {
      const batch = buildClaudeCredentialBatch({ ...claudeBase, mode });
      const setKeys = batch.operations
        .filter((operation) => operation.operation === "set")
        .map((operation) => operation.key);
      const deleteKeys = batch.operations
        .filter((operation) => operation.operation === "delete")
        .map((operation) => operation.key);

      expect(setKeys).toEqual(expectedSetKeys);
      expect(new Set([...setKeys, ...deleteKeys]).size).toBe(batch.operations.length);
      expect(deleteKeys).toEqual(expect.arrayContaining(
        [
          "CLAUDE_CODE_USE_VERTEX",
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_USE_ANTHROPIC_AWS",
          "CLAUDE_CODE_USE_FOUNDRY",
        ].filter((key) => !expectedSetKeys.includes(key)),
      ));
    },
  );

  it("switches Google routes without retaining the conflicting API key or Vertex flag", () => {
    const apiKey = buildGoogleCredentialBatch({
      mode: "gemini_api_key",
      apiKey: "gemini-secret",
      projectId: "",
      location: "",
    });
    const vertex = buildGoogleCredentialBatch({
      mode: "vertex",
      apiKey: "",
      projectId: "project-id",
      location: "us-central1",
    });

    expect(apiKey.operations).toEqual(expect.arrayContaining([
      { operation: "set", key: "GEMINI_API_KEY", value: "gemini-secret" },
      { operation: "delete", key: "GOOGLE_GENAI_USE_VERTEXAI" },
    ]));
    expect(vertex.operations).toEqual(expect.arrayContaining([
      { operation: "delete", key: "GEMINI_API_KEY" },
      { operation: "set", key: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
    ]));
  });

  it("orders every selected set before conflicting deletes", () => {
    for (const batch of [
      buildClaudeCredentialBatch({ ...claudeBase, mode: "vertex" }),
      buildGoogleCredentialBatch({
        mode: "vertex",
        apiKey: "",
        projectId: "project-id",
        location: "us-central1",
      }),
    ]) {
      const firstDelete = batch.operations.findIndex(
        (operation) => operation.operation === "delete",
      );
      const lastSet = batch.operations.findLastIndex(
        (operation) => operation.operation === "set",
      );
      expect(firstDelete).toBeGreaterThan(lastSet);
    }
  });

  it("removes every JobCtrl-managed key for Claude and Google without crossing provider boundaries", () => {
    expect(removeClaudeProviderBatch().operations).toEqual([
      { operation: "delete", key: "ANTHROPIC_API_KEY" },
      { operation: "delete", key: "CLAUDE_CODE_USE_VERTEX" },
      { operation: "delete", key: "ANTHROPIC_VERTEX_PROJECT_ID" },
      { operation: "delete", key: "CLOUD_ML_REGION" },
      { operation: "delete", key: "CLAUDE_CODE_USE_BEDROCK" },
      { operation: "delete", key: "CLAUDE_CODE_USE_ANTHROPIC_AWS" },
      { operation: "delete", key: "ANTHROPIC_AWS_WORKSPACE_ID" },
      { operation: "delete", key: "CLAUDE_CODE_USE_FOUNDRY" },
      { operation: "delete", key: "ANTHROPIC_FOUNDRY_RESOURCE" },
      { operation: "delete", key: "AWS_REGION" },
      { operation: "delete", key: "AWS_PROFILE" },
    ]);
    expect(removeGoogleProviderBatch().operations).toEqual([
      { operation: "delete", key: "GEMINI_API_KEY" },
      { operation: "delete", key: "GOOGLE_GENAI_USE_VERTEXAI" },
      { operation: "delete", key: "GOOGLE_CLOUD_PROJECT" },
      { operation: "delete", key: "GOOGLE_CLOUD_LOCATION" },
    ]);
    expect(removeClaudeProviderBatch().operations).not.toContainEqual(
      expect.objectContaining({ key: "OPENAI_API_KEY" }),
    );
    expect(removeGoogleProviderBatch().operations).not.toContainEqual(
      expect.objectContaining({ key: "OPENAI_API_KEY" }),
    );
  });
});
