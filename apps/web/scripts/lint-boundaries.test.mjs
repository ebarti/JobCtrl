import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import ts from "typescript";
import { dependencies, lintProgram, webRoot } from "./lint-boundaries.mjs";

function check(files, exemptions = {}) {
  const sources = new Map(
    Object.entries(files).map(([path, source]) => [
      resolve(webRoot, "src", path),
      source,
    ]),
  );
  const options = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    baseUrl: webRoot,
    paths: { "@/*": ["src/*"] },
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const readFile = host.readFile.bind(host);
  const directoryExists = host.directoryExists.bind(host);
  host.directoryExists = (path) =>
    [...sources.keys()].some((file) => file.startsWith(`${path}/`)) ||
    directoryExists(path);
  host.fileExists = (path) => sources.has(path) || fileExists(path);
  host.readFile = (path) => sources.get(path) ?? readFile(path);
  host.getSourceFile = (path, languageVersion, onError) =>
    sources.has(path)
      ? ts.createSourceFile(path, sources.get(path), languageVersion, true)
      : getSourceFile(path, languageVersion, onError);
  const program = ts.createProgram([...sources.keys()], options, host);
  // Ignore unrelated real imported production files; the fixture owns its source set.
  const scoped = {
    getTypeChecker: () => program.getTypeChecker(),
    getCompilerOptions: () => options,
    getSourceFile: (path) => program.getSourceFile(path),
    getSourceFiles: () =>
      program.getSourceFiles().filter((source) => sources.has(source.fileName)),
  };
  return lintProgram(scoped, webRoot, exemptions);
}
const rules = (results) =>
  [...new Set(results.map((result) => result.rule))].sort();

// These are deliberate negative controls: invalid source must yield diagnostics.
test("all static module syntaxes preserve actual dependency and original symbol names", () => {
  const source = ts.createSourceFile(
    "example.ts",
    `
    import type { JobSummary as Job } from '@jobctrl/contracts';
    export { JobDetail as Detail } from '@jobctrl/contracts';
    import C = require('@jobctrl/contracts');
    const a = import(\`@jobctrl/contracts\`);
    const b = require('@jobctrl/contracts');
    type T = import('@jobctrl/contracts').JobDetail;
    // import('not-a-dependency')
    const text = "import('also-not-a-dependency')";
  `,
    ts.ScriptTarget.Latest,
    true,
  );
  assert.deepEqual(
    dependencies(source).map(({ specifier, names }) => [specifier, names]),
    [
      ["@jobctrl/contracts", ["JobSummary"]],
      ["@jobctrl/contracts", ["JobDetail"]],
      ["@jobctrl/contracts", ["*"]],
      ["@jobctrl/contracts", ["*"]],
      ["@jobctrl/contracts", ["*"]],
      ["@jobctrl/contracts", ["JobDetail"]],
    ],
  );
});
test("rejects direct contracts with location and a useful ACL diagnostic", () => {
  const result = check({
    "views/lint-example/Page.ts":
      "import type { JobSummary as Row } from '@jobctrl/contracts';",
  });
  assert.deepEqual(rules(result), ["operations-acl"]);
  assert.equal(result[0].line, 1);
  assert.equal(result[0].column, 1);
  assert.match(result[0].message, /JobSummary.*contexts\/operations\/types.ts/);
});
test("exact file and symbol exemptions allow reviewed access but not additional imports", () => {
  const exemptions = {
    contracts: {
      "views/lint-example/Page.ts": {
        symbols: ["JobSummary"],
        reason: "Reviewed migration debt",
      },
    },
  };
  assert.deepEqual(
    check(
      {
        "views/lint-example/Page.ts":
          "import type { JobSummary as Row } from '@jobctrl/contracts';",
      },
      exemptions,
    ),
    [],
  );
  assert.deepEqual(
    rules(
      check(
        {
          "views/lint-example/Page.ts":
            "import type { JobSummary, JobDetail } from '@jobctrl/contracts';",
        },
        exemptions,
      ),
    ),
    ["operations-acl"],
  );
  assert.deepEqual(
    rules(
      check(
        {
          "views/elsewhere/Page.ts":
            "import type { JobSummary } from '@jobctrl/contracts';",
        },
        exemptions,
      ),
    ),
    ["operations-acl", "stale-exemption"],
  );
});
test("removes stale or unreasoned exemptions", () => {
  assert.deepEqual(
    rules(
      check(
        { "views/lint-example/Page.ts": "export {};" },
        {
          contracts: {
            "views/lint-example/Page.ts": {
              symbols: ["JobSummary"],
              reason: "Old access",
            },
          },
        },
      ),
    ),
    ["stale-exemption"],
  );
});
test("ACL owner, domain vocabulary and ordinary React hooks remain legal", () => {
  assert.deepEqual(
    check({
      "contexts/operations/types.ts":
        "export type { JobSummary } from '@jobctrl/contracts';",
      "views/lint-example/Page.ts":
        "import { useState, useEffect, useRef } from 'react'; import type { TenantId } from '@jobctrl/domain-types'; import type { JobSummary } from '../../contexts/operations/types.js';",
    }),
    [],
  );
});
test("views reject aliased runtime Query and Zustand imports, allowing type-only Query and API errors", () => {
  assert.deepEqual(
    rules(
      check({
        "views/lint-example/Page.ts":
          "import { useQuery as load } from '@tanstack/react-query'; import { create as store } from 'zustand';",
      }),
    ),
    ["view-state"],
  );
  assert.deepEqual(
    check({
      "views/lint-example/Page.ts":
        "import type { UseMutationResult } from '@tanstack/react-query'; import { type QueryClient } from '@tanstack/react-query'; import { JobCtrlApiError } from '@jobctrl/api-client';",
    }),
    [],
  );
});
test("context-view, cross-view and test-support edges resolve aliases and .js source imports", () => {
  assert.deepEqual(
    rules(
      check({
        "contexts/lint-one/file.ts":
          "import { example } from '@/views/lint-two/Page.js';",
        "views/lint-two/Page.ts": "export const example = 1;",
        "views/lint-one/Page.ts":
          "export { example } from '../lint-two/Page.js'; import '../../test/lint-fixture.js';",
        "test/lint-fixture.ts": "export {};",
      }),
    ),
    ["context-view", "production-import", "view-view"],
  );
});
test("cross-aggregate hook/store edges cannot hide behind renamed barrel exports", () => {
  assert.deepEqual(
    rules(
      check({
        "contexts/lint-one/file.ts":
          "import { publicHook as renamed } from '../lint-two/index.js';",
        "contexts/lint-two/index.ts":
          "export { useExample as publicHook } from './hooks/useExample.js';",
        "contexts/lint-two/hooks/useExample.ts":
          "export function useExample() {}",
      }),
    ),
    ["aggregate-state"],
  );
});
test("Operations read hooks and context-owned view hooks remain legal", () => {
  assert.deepEqual(
    check({
      "contexts/lint-one/file.ts":
        "import { useExample } from '../operations/hooks/lintExample.js';",
      "contexts/operations/hooks/lintExample.ts":
        "export function useExample() {}",
      "views/lint-one/Page.ts":
        "import { useExample } from '../../contexts/lint-two/hooks/lintExample.js';",
      "contexts/lint-two/hooks/lintExample.ts":
        "export function useExample() {}",
    }),
    [],
  );
});
test("browser capabilities resolve aliases, computed members and local shadowing", () => {
  const result = check({
    "contexts/lint-one/file.ts": `
    const request = fetch; request('/resource');
    window['localStorage'].getItem('key');
    const { sessionStorage: storage } = window;
    const events = window.dispatchEvent;
    new EventSource('/events'); navigator.clipboard.writeText('hello');
  `,
  });
  assert.deepEqual(rules(result), ["browser-port"]);
  for (const name of [
    "fetch",
    "localStorage",
    "sessionStorage",
    "dispatchEvent",
    "EventSource",
    "clipboard",
  ])
    assert.ok(
      result.some((item) => item.message.includes(name)),
      name,
    );
  assert.deepEqual(
    check({
      "contexts/lint-one/file.ts":
        "export function local(fetch: (value: string) => void, window: { localStorage: string }) { fetch(window.localStorage); }",
    }),
    [],
  );
});
test("API methods obtained through the port remain forbidden in a view, including aliases", () => {
  const result = check({
    "views/lint-example/Page.ts": `
    import type { ApiClientPort } from '../../shared/ports/ApiClientPort.js';
    declare const client: ApiClientPort;
    client.jobs({}); const request = client['job']; const { health: readHealth } = client;
  `,
  });
  assert.deepEqual(rules(result), ["view-api"]);
  for (const name of ["jobs", "job", "health"])
    assert.ok(
      result.some((item) => item.message.includes(name)),
      name,
    );
});
test("a preview helper exemption does not allow network reads", () => {
  const result = check(
    {
      "views/lint-example/Page.ts": `
    import type { ApiClientPort } from '../../shared/ports/ApiClientPort.js';
    declare const client: ApiClientPort;
    client.artifactPreviewPdfUrl('id'); client.health();
  `,
    },
    {
      capabilities: {
        "views/lint-example/Page.ts": {
          symbols: ["artifactPreviewPdfUrl"],
          reason: "Pure URL helper",
        },
      },
    },
  );
  assert.deepEqual(rules(result), ["view-api"]);
  assert.match(result[0].message, /health/);
});
test("concrete transport and primitive packages are rejected in features", () => {
  assert.deepEqual(
    rules(
      check({
        "views/lint-example/Page.ts":
          "import { JobCtrlApiClient } from '@jobctrl/api-client'; import * as Dialog from '@base-ui/react/dialog'; import('@radix-ui/react-dialog');",
      }),
    ),
    ["api-adapter", "ui-wrapper"],
  );
});
test("computed dependencies are explicit violations and tests are not feature code", () => {
  assert.deepEqual(
    rules(
      check({
        "views/lint-example/Page.ts":
          "declare const name: string; import(name);",
      }),
    ),
    ["static-dependency"],
  );
  assert.deepEqual(
    check({
      "views/lint-example/Page.test.ts":
        "import { JobSummary } from '@jobctrl/contracts'; fetch('/test');",
    }),
    [],
  );
});

// Review regressions: equivalent import syntax must not weaken ownership.
test("shared re-exports cannot launder runtime Query or API client classes into views", () => {
  assert.deepEqual(
    rules(
      check({
        "shared/lint-query.ts":
          "export { useQuery as load } from '@tanstack/react-query'; export { JobCtrlApiClient as Client } from '@jobctrl/api-client';",
        "views/lint-example/Page.ts":
          "import { load, Client } from '../../shared/lint-query.js';",
      }),
    ),
    ["api-adapter", "view-state"],
  );
});
test("dynamic, require and import-type aggregate barrels preserve hook ownership", () => {
  for (const statement of [
    "const hooks = await import('../lint-two/index.js');",
    "const hooks = require('../lint-two/index.js');",
    "import hooks = require('../lint-two/index.js');",
    "type Hook = typeof import('../lint-two/index.js').useExample;",
  ]) {
    assert.deepEqual(
      rules(
        check({
          "contexts/lint-one/file.ts": statement,
          "contexts/lint-two/index.ts":
            "export { useExample } from './hooks/useExample.js';",
          "contexts/lint-two/hooks/useExample.ts":
            "export function useExample() {}",
        }),
      ),
      ["aggregate-state"],
      statement,
    );
  }
});

test("views cannot operate on a QueryClient obtained through typed context", () => {
  assert.deepEqual(
    rules(
      check({
        "views/lint-example/Page.ts":
          "import type { QueryClient } from '@tanstack/react-query'; declare const context: { queryClient: QueryClient }; context.queryClient.invalidateQueries(); const { setQueryData: write } = context.queryClient;",
      }),
    ),
    ["view-state"],
  );
});
