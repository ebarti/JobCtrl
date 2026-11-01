import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { dependencies, webRoot } from "./lint-boundaries.mjs";

import { check, rules } from "./lint-boundaries-fixtures.mjs";

// Dependency parsing supports both positive canonical imports and negative controls.
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
test("canonical DTOs, schemas, constants and domain vocabulary need no routing exemption", () => {
  for (const file of [
    "views/lint-example/Page.ts",
    "contexts/lint-one/file.ts",
    "routes/lint-page.ts",
  ]) {
    assert.deepEqual(
      check({
        [file]: `import type { JobSummary as Row } from '@jobctrl/contracts';
        import { JobListQuerySchema, JOB_STATES } from '@jobctrl/contracts';
        import type { DomainEventUnion, TenantId } from '@jobctrl/domain-types';
        type Detail = import('@jobctrl/contracts').JobDetail;`,
      }),
      [],
    );
  }
});
test("canonical imports do not grant API-client or Query capabilities", () => {
  assert.deepEqual(
    rules(
      check({
        "views/lint-example/Page.ts":
          "import { JobListQuerySchema } from '@jobctrl/contracts'; import { JobCtrlApiClient } from '@jobctrl/api-client'; import { useQuery } from '@tanstack/react-query'; fetch('/resource');",
      }),
    ),
    ["api-adapter", "browser-port", "view-state"],
  );
});
test("exact capability exemptions allow reviewed access but not additional symbols or files", () => {
  const exemptions = {
    capabilities: {
      "contexts/lint-one/file.ts": {
        symbols: ["fetch"],
        reason: "Owned abortable preview load",
      },
    },
  };
  assert.deepEqual(
    check({ "contexts/lint-one/file.ts": "fetch('/preview');" }, exemptions),
    [],
  );
  assert.deepEqual(
    rules(
      check(
        {
          "contexts/lint-one/file.ts":
            "fetch('/preview'); localStorage.getItem('key');",
        },
        exemptions,
      ),
    ),
    ["browser-port"],
  );
  assert.deepEqual(
    rules(
      check({ "contexts/lint-two/file.ts": "fetch('/preview');" }, exemptions),
    ),
    ["browser-port", "stale-exemption"],
  );
});
test("removes stale or unreasoned capability and dependency exemptions", () => {
  for (const group of ["capabilities", "dependencies"]) {
    for (const reason of ["Old access", ""]) {
      assert.deepEqual(
        rules(
          check(
            { "views/lint-example/Page.ts": "export {};" },
            {
              [group]: {
                "views/lint-example/Page.ts": { symbols: ["unused"], reason },
              },
            },
          ),
        ),
        ["stale-exemption"],
      );
    }
  }
  assert.deepEqual(
    rules(
      check(
        { "contexts/lint-one/file.ts": "fetch('/preview');" },
        {
          capabilities: {
            "contexts/lint-one/file.ts": { symbols: ["fetch"], reason: "" },
          },
        },
      ),
    ),
    ["browser-port", "stale-exemption"],
  );
});
test("ordinary React hooks remain legal with canonical DTO imports", () => {
  assert.deepEqual(
    check({
      "views/lint-example/Page.ts":
        "import { useState, useEffect, useRef } from 'react'; import type { TenantId } from '@jobctrl/domain-types'; import type { JobSummary } from '@jobctrl/contracts';",
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
  const previewOnly = check(
    {
      "views/lint-example/Page.ts": `import type { ApiClientPort } from '../../shared/ports/ApiClientPort.js';
      declare const client: ApiClientPort; client.artifactPreviewPdfUrl('id');`,
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
  assert.deepEqual(previewOnly, []);
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
  assert.ok(
    result.some(
      (item) =>
        item.rule === "view-api" &&
        item.file === "views/lint-example/Page.ts" &&
        item.line === 4 &&
        item.column > 0 &&
        item.message.includes("health"),
    ),
  );
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

test("the actual tsconfig and generated routes delegate reads without exemptions", () => {
  const generated = readFileSync(
    resolve(webRoot, "src/routeTree.gen.ts"),
    "utf8",
  );
  assert.match(generated, /dashboard/);
  assert.match(generated, /activity/);
  // Full production lint runs independently in the Frontend job. This control
  // owns the generated routes, with the real complete compiler graph retained.
  const routes = ["routes/dashboard.tsx", "routes/activity.$eventId.tsx"];
  const files = Object.fromEntries(
    routes.map((file) => [
      file,
      readFileSync(resolve(webRoot, "src", file), "utf8"),
    ]),
  );
  const results = check(files, {}, true);
  assert.deepEqual([...results], []);
  assert.deepEqual(results.compilerDiagnostics, []);
});

test("real generated loaders reject direct capabilities independently of any/unresolved types", () => {
  const filename = "routes/dashboard.tsx";
  const original = readFileSync(resolve(webRoot, "src", filename), "utf8");
  const controls = [
    ["context.ports.api.health();", "view-api"],
    ["context.queryClient.clear();", "view-state"],
    ["(context as any).ports.api.health();", "view-api"],
    ["(context as unknown as { ports: any }).ports.api.health();", "view-api"],
    ["const c = context; const a = c.ports.api; a.health();", "view-api"],
    ["const { ports: { api: a } } = context; a.health();", "view-api"],
    ["const { health: read } = context.ports.api; read();", "view-api"],
    ["context['ports']['api']['health']();", "view-api"],
    ["const key = 'health'; context.ports.api[key]();", "view-api"],
    ["const { queryClient: q } = context; q['clear']();", "view-state"],
    ["const { clear: reset } = context.queryClient; reset();", "view-state"],
    ["const c: any = context; c.queryClient.prefetchQuery({});", "view-state"],
    [
      "const { context: { ports: { api } } } = { context }; api.health();",
      "view-api",
    ],
    ["let a: any; a = context.ports.api; a.health();", "view-api"],
    [
      "const api = context.ports.api; const box = { first: api, second: api }; box.second.health();",
      "view-api",
    ],
    ["const [api] = [context.ports.api]; api!.health();", "view-api"],
    ["const clients = [context.ports.api]; clients[0]!.health();", "view-api"],
    ["const api = context.ports.api ?? {}; api.health();", "view-api"],
    [
      "const api: any = Math.random() ? {} : context.ports.api; api.health();",
      "view-api",
    ],
    [
      "const { client: api = context.ports.api } = {} as any; api.health();",
      "view-api",
    ],
    [
      "const box: any = {}; box.client = context.ports.api; box.client.health();",
      "view-api",
    ],
    [
      "const key: string = ['queryClient'][0]!; (context as any)[key].clear();",
      "view-state",
    ],
    [
      "const key: string = ['api'][0]!; context.ports[key as 'api'].health();",
      "view-api",
    ],
  ];
  // Overlay the real route at its generated-tree identity. Both weak and missing
  // declarations must still diagnose every source line, not merely fail tsc.
  for (const annotation of [
    undefined,
    '{ context: import("../router.js").RouterContext }',
    "any",
    "MissingLoaderArguments",
  ]) {
    const body = controls.map(([code]) => `    { ${code} }`).join("\n");
    const parameter = annotation ? `: ${annotation}` : "";
    const replacement = `  loader: async ({ context }${parameter}) => {\n${body}\n  },`;
    const text = original.replace(/  loader:.*\n/, replacement + "\n");
    const results = check({ [filename]: text }, {}, true);
    if (annotation === "MissingLoaderArguments")
      assert.ok(
        results.compilerDiagnostics.some((d) =>
          ts
            .flattenDiagnosticMessageText(d.messageText, " ")
            .includes(annotation),
        ),
        "unresolved compiler control executed",
      );
    else
      assert.equal(
        results.compilerDiagnostics.length,
        0,
        `${annotation ?? "generated inference"} control is compiler-clean and must still fail the boundary`,
      );
    const firstLine = text.slice(0, text.indexOf(body)).split("\n").length;
    controls.forEach(([code, rule], index) => {
      assert.ok(
        results.some(
          (d) =>
            d.file === filename &&
            d.line === firstLine + index &&
            d.column > 0 &&
            d.rule === rule,
        ),
        `${annotation}: ${code}\n${JSON.stringify(results)}`,
      );
    });
  }
});

test("capability provenance survives view casts, hook aliases and nested destructuring", () => {
  const result = check({
    "views/lint-example/Page.ts": `
      import { usePorts as obtain } from '../../shared/providers/PortsProvider.js';
      const p: any = obtain(); const { api: client } = p;
      (client as any)['health']();
      const { health: read } = client; read();
    `,
  });
  assert.deepEqual(rules(result), ["view-api"]);
  assert.ok(result.some((d) => d.message.includes("health")));
  assert.deepEqual(
    check({
      "views/lint-example/Page.ts": `
      const context = { ports: { api: { health() {} } }, queryClient: { clear() {} } };
      const usePorts = () => context.ports;
      context.ports.api.health(); context.queryClient.clear(); usePorts().api.health();
      const Route = { useRouteContext: () => context }; Route.useRouteContext().ports.api.health();
      type LocalContext = typeof context;
      const local = { loader: ({ context }: { context: LocalContext }) => context.ports.api.health() };
    `,
    }),
    [],
  );
});

test("unresolved runtime re-exports cannot launder Query or concrete API authority", () => {
  const files = {
    "shared/lint-weak-barrel.ts": `
      export { useQuery as fetcher } from '@tanstack/react-query/missing-declaration';
      export { JobCtrlApiClient as Client } from '@jobctrl/api-client/missing-declaration';
      export type { QueryClient as QueryType } from '@tanstack/react-query';
    `,
    "shared/lint-outer.ts":
      "export { fetcher as load, Client } from './lint-weak-barrel.js'; export type { QueryType } from './lint-weak-barrel.js';",
    "views/lint-example/Page.ts":
      "import { load, Client } from '../../shared/lint-outer.js';",
  };
  assert.deepEqual(rules(check(files)), ["api-adapter", "view-state"]);
  assert.deepEqual(
    check({
      ...files,
      "views/lint-example/Page.ts":
        "import type { QueryType } from '../../shared/lint-outer.js';",
    }),
    [],
  );
});

test("loader callback aliases preserve capability ownership with weak parameter types", () => {
  const result = check({
    "routes/lint-loader.ts": `
      import { createFileRoute as route } from '@tanstack/react-router';
      const load = ({ context: c }: any) => c.ports.api.health();
      const alias = load;
      export const Route = route('/dashboard')({ loader: alias });
    `,
  });
  assert.deepEqual(rules(result), ["view-api"]);
  assert.ok(
    result.some(
      (d) => d.file === "routes/lint-loader.ts" && d.line === 3 && d.column > 0,
    ),
  );
});

test("any and unresolved capability slots fail closed without granting permission from a missing origin", () => {
  for (const type of ["any", "MissingContext"]) {
    const result = check({
      "views/lint-example/Page.ts": `
        declare const context: ${type};
        context.ports.api.health();
        context.queryClient.clear();
        const { ports: { api: client } } = context; client.health();
        const { queryClient: query } = context; query.clear();
      `,
    });
    assert.deepEqual(rules(result), ["view-api", "view-state"]);
    for (const [line, rule] of [
      [3, "view-api"],
      [4, "view-state"],
      [5, "view-api"],
      [6, "view-state"],
    ])
      assert.ok(
        result.some((d) => d.line === line && d.rule === rule),
        `${type}: ${line}`,
      );
  }
});

test("local import/export aliases cannot hide unresolved runtime capabilities", () => {
  for (const [module, imported, rule] of [
    ["@tanstack/react-query/missing-declaration", "useQuery", "view-state"],
    [
      "@jobctrl/api-client/missing-declaration",
      "JobCtrlApiClient",
      "api-adapter",
    ],
  ]) {
    for (const declaration of [
      "export { original as load };",
      "const alias = original; export { alias as load };",
      "export const load = original;",
    ])
      assert.deepEqual(
        rules(
          check({
            "shared/lint-import-export.ts": `import { ${imported} as original } from '${module}'; ${declaration}`,
            "views/lint-example/Page.ts":
              "import { load } from '../../shared/lint-import-export.js';",
          }),
        ),
        [rule],
        declaration,
      );
  }
  assert.deepEqual(
    check({
      "contexts/lint-one/hooks/useOwned.ts":
        "import { useQuery } from '@tanstack/react-query/missing-declaration'; export function useOwned() { return useQuery({}); }",
      "views/lint-example/Page.ts":
        "import { useOwned } from '../../contexts/lint-one/hooks/useOwned.js'; useOwned();",
    }),
    [],
  );
});

test("API provenance survives repeated container aliases and array destructuring", () => {
  for (const code of [
    "const api = context.ports.api; const box = { first: api, second: api }; box.second.health();",
    "const [api] = [context.ports.api]; api.health();",
    "const clients = [context.ports.api]; clients[0]!.health();",
  ]) {
    const result = check({
      "routes/lint-loader.ts": `import { createFileRoute } from '@tanstack/react-router';
      export const Route = createFileRoute('/dashboard')({ loader: ({ context }: any) => {
        ${code}
      } });`,
    });
    assert.ok(
      result.some((d) => d.rule === "view-api" && d.line === 3),
      code,
    );
  }
});

const reviewControls = [
  [
    "let api: any; ({ client: api = context.ports.api } = {} as any); api.health();",
    "view-api",
  ],
  [
    "let api: any; [api = context.ports.api] = [] as any; api.health();",
    "view-api",
  ],
  [
    "const box: any = {}; ({ client: box.api } = { client: context.ports.api }); box.api.health();",
    "view-api",
  ],
  [
    "let key: string; ({ value: key } = { value: ['queryClient'][0]! }); context[key].clear();",
    "view-state",
  ],
  ["const api = context.ports.api ?? {}; api.health();", "view-api"],
  [
    "const api: any = Math.random() ? context.ports.api : {}; api.health();",
    "view-api",
  ],
  [
    "const api: any = Math.random() ? {} : context.ports.api; api.health();",
    "view-api",
  ],
  [
    "const { client: api = context.ports.api } = {} as any; api.health();",
    "view-api",
  ],
  [
    "const { optional: { api } = context.ports } = {} as any; api.health();",
    "view-api",
  ],
  [
    "const box: any = {}; box.client = context.ports.api; box.client.health();",
    "view-api",
  ],
  [
    "const box: any = {}; const alias = box; alias.client = context.ports.api; box.client.health();",
    "view-api",
  ],
  [
    "const key: string = ['queryClient'][0]!; context[key].clear();",
    "view-state",
  ],
  ["const key: string = ['ports'][0]!; context[key].api.health();", "view-api"],
  ["const key: string = ['api'][0]!; context.ports[key].health();", "view-api"],
  [
    "const key: string = ['queryClient'][Math.floor(Math.random())]!; context[key].clear();",
    "view-state",
  ],
  [
    "const key: string = ['api'][Math.floor(Math.random())]!; context.ports[key].health();",
    "view-api",
  ],
  ["const api = context.ports.api || {}; api.health();", "view-api"],
  [
    "const api = context.ports.api && context.ports.api; api.health();",
    "view-api",
  ],
  [
    "const box: any = { nest: {} }; const alias = box.nest; alias.client ??= context.ports.api; box.nest.client.health();",
    "view-api",
  ],
  [
    "const box: any = {}; const key = ['client'][0]!; box[key] = context.ports.api; box.client.health();",
    "view-api",
  ],
  [
    "const api: any = Math.random() ? context.ports.api : context.queryClient; api.health();",
    "view-api",
  ],
  [
    "const query: any = Math.random() ? context.ports.api : context.queryClient; query.clear();",
    "view-state",
  ],
  [
    "const key: string = Math.random() ? 'tenantId' : String(Math.random()); context[key].clear();",
    "view-state",
  ],
  [
    "const key: string = Math.random() ? 'clipboard' : String(Math.random()); context.ports[key].health();",
    "view-api",
  ],
];

test("review findings: real generated loader expression and computed-key aliases retain authority", () => {
  const file = "routes/dashboard.tsx";
  const original = readFileSync(resolve(webRoot, "src", file), "utf8");
  const body = reviewControls.map(([code]) => `    { ${code} }`).join("\n");
  const text = original.replace(
    /  loader:.*\n/,
    `  loader: async ({ context }: any) => {\n${body}\n  },\n`,
  );
  const view = "views/lint-review/Page.ts";
  const viewHeader = `import { useRouteContext } from '@tanstack/react-router';\nconst context: any = useRouteContext({ strict: false });\n`;
  const results = check({ [file]: text, [view]: viewHeader + body }, {}, true);
  console.log(
    JSON.stringify({
      control: "review-loader",
      inputs: reviewControls,
      boundary: results,
      compiler: results.compilerDiagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ),
    }),
  );
  assert.equal(results.compilerDiagnostics.length, 0);
  const line = text.slice(0, text.indexOf(body)).split("\n").length;
  const missing = [
    [file, line],
    [view, viewHeader.split("\n").length],
  ].flatMap(([path, first]) =>
    reviewControls.filter(
      ([, rule], i) =>
        !results.some(
          (d) =>
            d.file === path &&
            d.line === first + i &&
            d.column > 0 &&
            d.rule === rule,
        ),
    ),
  );
  assert.deepEqual(missing, []);
});

test("review findings: container and destructured barrel exports retain runtime authority", () => {
  for (const suffix of ["", "/missing-declaration"]) {
    const files = {};
    const expected = [];
    for (const [module, imported, rule] of [
      ["@tanstack/react-query", "useQuery", "view-state"],
      ["@jobctrl/api-client", "JobCtrlApiClient", "api-adapter"],
    ]) {
      const cases = [
        ["export { Original as load };", "tools.load"],
        [
          "export const runtime = { nested: { member: Original } };",
          "tools.runtime.nested.member",
        ],
        [
          "const { member: load } = { member: Original }; export { load };",
          "tools.load",
        ],
        ["export const { member: load } = { member: Original };", "tools.load"],
        [`export const { ${imported}: load } = space;`, "tools.load"],
        ["export const { absent: load = Original } = {} as any;", "tools.load"],
        ["export const [load] = [Original];", "tools.load"],
        ["export const [load] = [...[Original]];", "tools.load"],
        ["export const load = await Original;", "tools.load"],
        ["export const load = (Math.random(), Original);", "tools.load"],
        [
          "const forward = (value: any) => value; export const load = forward(Original);",
          "tools.load",
        ],
        ["export const [, ...loads] = [null, Original];", "tools.loads[0]"],
        ["export const loads = [null, ...[Original]];", "tools.loads[1]"],
        [
          "const prefix: any[] = []; export const loads = [...prefix, Original];",
          "tools.loads[0]",
        ],
        [
          "export const runtime: any = {}; runtime.member = Original;",
          "tools.runtime.member",
        ],
        [
          "const runtime = { member: Original }; export const load = runtime.member;",
          "tools.load",
        ],
        [
          "export const load = Math.random() ? Original : () => undefined;",
          "tools.load",
        ],
        [
          "export const load = (Original as any) ?? (() => undefined);",
          "tools.load",
        ],
      ];
      for (const [declaration, use] of cases) {
        const id = expected.length;
        const file = `views/lint-review-${id}/Page.ts`;
        files[`shared/lint-review-${id}.ts`] =
          `import { ${imported} as Original } from '${module}${suffix}';
          import * as space from '${module}${suffix}'; ${declaration}`;
        files[file] =
          `import * as tools from '../../shared/lint-review-${id}.js'; (${use} as any)({});`;
        expected.push({ file, rule, declaration });
      }
    }
    const results = check(files, {}, true);
    console.log(
      JSON.stringify({
        control: "review-barrel",
        suffix,
        inputs: files,
        boundary: results,
        compiler: results.compilerDiagnostics.map((d) =>
          ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        ),
      }),
    );
    if (!suffix) assert.equal(results.compilerDiagnostics.length, 0);
    else
      assert.ok(
        results.compilerDiagnostics.some((d) =>
          ts
            .flattenDiagnosticMessageText(d.messageText, " ")
            .includes("missing-declaration"),
        ),
      );
    assert.deepEqual(
      expected.filter(
        ({ file, rule }) =>
          !results.some(
            (d) =>
              d.file === file &&
              d.rule === rule &&
              d.line === 1 &&
              d.column > 0,
          ),
      ),
      [],
    );
  }
});

test("provenance keeps selected helpers, error values, local shadowing and safe computed keys legal", () => {
  const files = {
    "contexts/lint-one/hooks/useOwned.ts": `import { useQuery } from '@tanstack/react-query';
      export const runtime = { useQuery }; export function useOwned() { return useQuery({ queryKey: ['owned'] }); }`,
    "shared/lint-safe-error.ts": `import * as wire from '@jobctrl/api-client'; export const { JobCtrlApiError: ErrorValue } = wire;`,
    "views/lint-example/Page.ts": `import { useOwned } from '../../contexts/lint-one/hooks/useOwned.js';
      import { ErrorValue } from '../../shared/lint-safe-error.js';
      import type { QueryClient } from '@tanstack/react-query';
      useOwned(); const ErrorAlias = ErrorValue;
      const context = { ports: { api: { health() {} } }, queryClient: { clear() {} } };
      const api = context.ports.api ?? {}; api.health();
      const box = { client: { health() {} } }; box.client = api; box.client.health();
      function shadow() { const box = { client: { health() {} } }; box.client.health(); }
      const key: string = ['queryClient'][0]!; context[key as 'queryClient'].clear();`,
    "routes/dashboard.tsx": readFileSync(
      resolve(webRoot, "src/routes/dashboard.tsx"),
      "utf8",
    ).replace(
      /  loader:.*\n/,
      `  loader: ({ context }) => { const key = ['tenantId'][0] as 'tenantId'; return context[key]; },\n`,
    ),
  };
  const results = check(files, {}, true);
  assert.deepEqual(
    results.compilerDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    ),
    [],
  );
  assert.deepEqual([...results], []);
});
