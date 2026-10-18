import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { webRoot } from "./lint-boundaries.mjs";
import { check, rules } from "./lint-boundaries-fixtures.mjs";

test("spread/rest and asynchronous or forwarding handoffs cannot escape capability ownership", () => {
  const controls = [
    ["const [api] = [...[context.ports.api]]; api.health();", "view-api"],
    [
      "const [, ...clients] = [null, context.ports.api]; clients[0].health();",
      "view-api",
    ],
    [
      "const [, ...clients] = [null, context.queryClient]; clients[0].clear();",
      "view-state",
    ],
    [
      "const prefix: any[] = []; const clients = [...prefix, context.ports.api]; clients[0].health();",
      "view-api",
    ],
    [
      "const [, ...[api]] = [null, context.ports.api]; api.health();",
      "view-api",
    ],
    [
      "let clients: any; [, ...clients] = [null, context.ports.api]; clients[0].health();",
      "view-api",
    ],
    [
      "const [key] = [...['queryClient']]; context[key!].clear();",
      "view-state",
    ],
    [
      "const [, ...keys] = [null, 'api']; context.ports[keys[0]!].health();",
      "view-api",
    ],
    ["const api = await context.ports.api; api.health();", "view-api"],
    [
      "const identity = (value: any) => value; const api = identity(context.ports.api); api.health();",
      "view-api",
    ],
    [
      "const forward = (value: any) => value; const api = await forward({ nested: [context.ports.api] }); api.nested[0].health();",
      "view-api",
    ],
    [
      "const forward = (...values: any[]) => values[0]; const api = forward(...[context.ports.api]); api.health();",
      "view-api",
    ],
    [
      "const identity = (value: any) => value; const client = identity(context.queryClient); client.clear();",
      "view-state",
    ],
    [
      "const forward = (value: any) => value.api; const api = forward(context.ports); api.health();",
      "view-api",
    ],
    [
      "const forward = (value: any) => value.ports.api; const api = forward(context); api.health();",
      "view-api",
    ],
    [
      "const forward: any = Math.random() ? prefetchDashboard : (value: any) => value; const api = forward(context.ports.api); api.health();",
      "view-api",
    ],
    [
      "let forward: any = prefetchDashboard; forward = (value: any) => value; const api = forward(context.ports.api); api.health();",
      "view-api",
    ],
    [
      "const forward = () => context.ports.api; const api = forward(); api.health();",
      "view-api",
    ],
    [
      "function forward() { return context.ports.api; } const api = forward(); api.health();",
      "view-api",
    ],
    ["const [api] = [...context.ports.api]; api.health();", "view-api"],
  ];
  const route = "routes/dashboard.tsx",
    view = "views/lint-handoffs/Page.ts";
  const body = controls.map(([code]) => `    { ${code} }`).join("\n");
  const routeText = readFileSync(
    resolve(webRoot, "src", route),
    "utf8",
  ).replace(
    /  loader:.*\n/,
    `  loader: async ({ context }: any) => {\n${body}\n  },\n`,
  );
  const viewHeader = `import { useRouteContext } from '@tanstack/react-router';\nimport { prefetchDashboard } from '../../contexts/operations/readQueries.js';\nasync function probe() { const context: any = useRouteContext({ strict: false });\n`;
  const inputs = { [route]: routeText, [view]: viewHeader + body + "\n}" };
  const results = check(inputs, {}, true);
  console.log(
    JSON.stringify({
      control: "spread-await-forward",
      inputs,
      boundary: results,
      compiler: results.compilerDiagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ),
    }),
  );
  assert.equal(results.compilerDiagnostics.length, 0);
  const missing = [
    [route, routeText.slice(0, routeText.indexOf(body)).split("\n").length],
    [view, viewHeader.split("\n").length],
  ].flatMap(([file, first]) =>
    controls.filter(
      ([, rule], i) =>
        !results.some(
          (d) =>
            d.file === file &&
            d.line === first + i &&
            d.column > 0 &&
            d.rule === rule,
        ),
    ),
  );
  assert.deepEqual(missing, []);
});

test("spread/rest preserve harmless positions and context-owned capability handoffs", () => {
  const inputs = {
    "contexts/lint-handoffs/read.ts": `export function read(api: any) { return { health() {} }; }`,
    "routes/dashboard.tsx": readFileSync(
      resolve(webRoot, "src/routes/dashboard.tsx"),
      "utf8",
    ).replace(
      /  loader:.*\n/,
      `  loader: async ({ context }) => {\n        const [tenant] = [...[context.tenantId]];\n        const [, ...ids] = [null, tenant];\n        const deps = { ...context, tenantId: ids[0] as typeof tenant };\n        return prefetchDashboard(deps);\n      },\n`,
    ),
    "views/lint-handoffs/Page.ts": `import { useRouteContext } from '@tanstack/react-router';
      import { read } from '../../contexts/lint-handoffs/read.js';
      const readAlias = read;
      async function probe() { const context: any = useRouteContext({ strict: false });
        const [safe] = [...[{ health() {} }], context.ports.api]; safe!.health();
        const [, ...safeTail] = [context.ports.api, { health() {} }]; safeTail[0].health();
        const dto = readAlias(context.ports.api); dto.health();
        const identity = (value: any) => value;
        const api = await identity({ health() {} }); api.health();
      }`,
  };
  const results = check(inputs, {}, true);
  assert.deepEqual(
    results.compilerDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    ),
    [],
  );
  assert.deepEqual([...results], []);
});

// Each row owns its source line in both the generated loader and a view.
function checkReviewForms(control, controls, extraFiles = {}, imports = "") {
  const route = "routes/dashboard.tsx",
    view = "views/lint-flow/Page.ts";
  const body = controls.map(([code]) => `    { ${code} }`).join("\n");
  const routeText = readFileSync(
    resolve(webRoot, "src", route),
    "utf8",
  ).replace(
    /  loader:.*\n/,
    `  loader: async ({ context }: any) => {\n${body}\n  },\n`,
  );
  const header = `import { useRouteContext } from '@tanstack/react-router';\nasync function probe() { const context: any = useRouteContext({ strict: false });\n`;
  const inputs = {
    ...extraFiles,
    [route]: imports + routeText,
    [view]: imports + header + body + "\n}",
  };
  const results = check(inputs, {}, true);
  console.log(
    JSON.stringify({
      control,
      inputs,
      boundary: results,
      compiler: results.compilerDiagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ),
    }),
  );
  assert.equal(results.compilerDiagnostics.length, 0);
  assert.deepEqual(
    [
      [
        route,
        (imports + routeText.slice(0, routeText.indexOf(body))).split("\n")
          .length,
      ],
      [view, (imports + header).split("\n").length],
    ].flatMap(([file, first]) =>
      controls
        .filter(
          ([, rule], i) =>
            !results.some(
              (d) =>
                d.file === file &&
                d.line === first + i &&
                d.column > 0 &&
                d.rule === rule,
            ),
        )
        .map(([code, rule]) => ({ file, code, rule })),
    ),
    [],
  );
}

test("review repairs: mixed default imports retain runtime export authority", () => {
  for (const suffix of ["", "/missing-declaration"]) {
    const inputs = {},
      expected = [];
    const barrel = "shared/lint-mixed.ts";
    inputs[barrel] =
      `import { QueryClient } from '@tanstack/react-query${suffix}';
      const Client: any = QueryClient; export default Client;
      export const marker = 1; export type Marker = number;`;
    for (const [i, clause] of [
      "Client",
      "Client, { marker }",
      "Client, { type Marker }",
    ].entries()) {
      for (const kind of ["routes", "views"]) {
        const file = `${kind}/lint-mixed-${i}.ts`;
        inputs[file] =
          `import ${clause} from '../shared/lint-mixed.js'; new Client().clear();`;
        expected.push(file);
      }
    }
    // Exercise the real generated loader too, keeping its route identity.
    const route = "routes/dashboard.tsx";
    inputs[route] =
      `import Client, { type Marker } from '../shared/lint-mixed.js';\nimport NamedClient, { marker } from '../shared/lint-mixed.js';\n` +
      readFileSync(resolve(webRoot, "src", route), "utf8").replace(
        /  loader:.*\n/,
        "  loader: () => { new Client().clear(); new NamedClient().clear(); },\n",
      );
    expected.push(route);
    const results = check(inputs, {}, true);
    console.log(
      JSON.stringify({
        control: "mixed-default-import",
        suffix,
        inputs,
        boundary: results,
        compiler: results.compilerDiagnostics.map((d) =>
          ts.flattenDiagnosticMessageText(d.messageText, "\n"),
        ),
      }),
    );
    if (!suffix) assert.equal(results.compilerDiagnostics.length, 0);
    else assert.ok(results.compilerDiagnostics.length > 0);
    assert.ok(
      results.some(
        (d) =>
          d.file === route &&
          d.rule === "view-state" &&
          d.line === 2 &&
          d.column > 0,
      ),
    );
    assert.deepEqual(
      expected.filter(
        (file) =>
          !results.some(
            (d) =>
              d.file === file &&
              d.rule === "view-state" &&
              d.line === 1 &&
              d.column > 0,
          ),
      ),
      [],
    );
  }
});

test("review repairs: parameter defaults and parameter properties retain capabilities", () => {
  checkReviewForms("parameter-default", [
    [
      "const read = (api: any = context.ports.api) => api.health(); read();",
      "view-api",
    ],
    [
      "function read(client: any = context.queryClient) { client.clear(); } read();",
      "view-state",
    ],
    [
      "const read = (box: any = { nested: context.ports.api }) => box.nested.health(); read();",
      "view-api",
    ],
    [
      "class Box { constructor(public api: any = context.ports.api) {} } new Box().api.health();",
      "view-api",
    ],
    [
      "class Box { constructor(readonly client: any = context.queryClient) {} } new Box().client.clear();",
      "view-state",
    ],
    [
      "class Box { constructor(private api: any = context.ports.api) {} run() { this.api.health(); } } new Box().run();",
      "view-api",
    ],
  ]);
});

test("review repairs: method receiver handoffs cannot erase container authority", () => {
  checkReviewForms("method-receiver", [
    ["const api = [context.ports.api].at(0); api.health();", "view-api"],
    ["const api = [context.ports.api].pop(); api.health();", "view-api"],
    ["[context.ports.api].forEach((api: any) => api.health());", "view-api"],
    [
      "const clients = [context.queryClient]; clients.pop().clear();",
      "view-state",
    ],
    [
      "const nested = { values: [context.ports.api] }; nested.values['at'](0).health();",
      "view-api",
    ],
    [
      "[context.queryClient].map((client: any) => client.clear());",
      "view-state",
    ],
  ]);
});

test("review repairs: context helpers cannot return raw capabilities through any", () => {
  checkReviewForms(
    "context-return",
    [
      ["rawApi(context).health();", "view-api"],
      ["rawClient(context).clear();", "view-state"],
      ["const alias = rawApi; alias(context).health();", "view-api"],
      ["identity(context.ports.api).health();", "view-api"],
      ["const { nested: api } = container(context); api.health();", "view-api"],
      ["(await rawAsync(context)).health();", "view-api"],
    ],
    {
      "contexts/lint-returns/read.ts": `export function rawApi(context: any): any { return context.ports.api; }
      export function rawClient(context: any): any { return context.queryClient; }
      export const identity = (value: any): any => value;
      export function container(context: any): any { const box: any = {}; box.nested = context.ports.api; return box; }
      export async function rawAsync(context: any): Promise<any> { return rawApi(context); }`,
      "shared/lint-returns.ts":
        "export * from '../contexts/lint-returns/read.js';",
    },
    "import { rawApi, rawClient, identity, container, rawAsync } from '../shared/lint-returns.js';\n".replace(
      "../shared",
      "@/shared",
    ),
  );
});

test("parameter, receiver and context return controls preserve DTOs and local shadowing", () => {
  const inputs = {
    "contexts/lint-dto/read.ts": `export function read(context: any): any { return { health() {}, tenantId: context.tenantId }; }
      export const identity = (value: any): any => value;
      export function readAsync(context: any) { return Promise.resolve(read(context)); }`,
    "views/lint-dto/Page.ts": `import { useRouteContext } from '@tanstack/react-router';
      import { read, identity, readAsync } from '../../contexts/lint-dto/read.js';
      async function probe() {
        const context: any = useRouteContext({ strict: false });
        read(context).health(); (await readAsync(context)).health();
        identity({ health() {} }).health();
        const run = (api = { health() {} }) => api.health(); run();
        class Box { constructor(public api = read(context)) {} } new Box().api.health();
        const values = [{ health() {} }]; values.at(0)!.health(); values.forEach(api => api.health());
        { const context = { ports: { api: { health() {} } } };
          const run = (api = context.ports.api) => api.health(); run();
          class Local { constructor(public api = context.ports.api) {} } new Local().api.health();
          [context.ports.api].pop()!.health(); }
      }`,
    "routes/dashboard.tsx": readFileSync(
      resolve(webRoot, "src/routes/dashboard.tsx"),
      "utf8",
    ).replace(
      /  loader:.*\n/,
      `  loader: ({ context }) => { const run = (deps = context) => prefetchDashboard(deps); return run(); },\n`,
    ),
  };
  const results = check(inputs, {}, true);
  console.log(
    JSON.stringify({
      control: "safe-returns-defaults-receivers",
      inputs,
      boundary: results,
      compiler: results.compilerDiagnostics.map((d) =>
        ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ),
    }),
  );
  assert.equal(results.compilerDiagnostics.length, 0);
  assert.deepEqual([...results], []);
});

test("review findings: for-of bindings retain iterable capability provenance", () => {
  checkReviewForms("for-of", [
    ["for (const api of [context.ports.api]) api.health();", "view-api"],
    [
      "for (const { nested: [api] } of [{ nested: [context.ports.api] }]) api.health();",
      "view-api",
    ],
    [
      "for (const c of [context]) { const key: string = String(Math.random()); c[key].clear(); }",
      "view-state",
    ],
    [
      "for (const [client] of [[context.queryClient]]) client.clear();",
      "view-state",
    ],
    [
      "const clients = [context.ports.api]; for (const api of clients) api.health();",
      "view-api",
    ],
    [
      "let api: any; for (api of [context.ports.api]) api.health();",
      "view-api",
    ],
    [
      "let api: any; for ({ nested: [api] } of [{ nested: [context.ports.api] }]) api.health();",
      "view-api",
    ],
    ["for await (const api of [context.ports.api]) api.health();", "view-api"],
    ["for (const key of ['queryClient']) context[key!].clear();", "view-state"],
    ["for (const { ports: { api } } of [context]) api.health();", "view-api"],
  ]);
});

test("review findings: comma results retain capability provenance", () => {
  checkReviewForms("comma", [
    [
      "const api = (Math.random(), context.ports.api); api.health();",
      "view-api",
    ],
    [
      "const client = (Math.random(), context.queryClient); client.clear();",
      "view-state",
    ],
    [
      "const c = (Math.random(), context); const key: string = String(Math.random()); c[key].clear();",
      "view-state",
    ],
    [
      "const { client: api } = (Math.random(), { client: context.ports.api }); api.health();",
      "view-api",
    ],
    [
      "const box: any = {}; const alias = (Math.random(), box); alias.client = context.ports.api; box.client.health();",
      "view-api",
    ],
    [
      "const key = (Math.random(), 'queryClient'); context[key].clear();",
      "view-state",
    ],
  ]);
});

test("review findings: class fields cannot acquire API or cache authority", () => {
  checkReviewForms("class-field", [
    [
      "class Box { client: any; run() { for (this.client of [context.ports.api]) this.client.health(); } } new Box().run();",
      "view-api",
    ],
    [
      "class Box { client: any; constructor() { this.client = context.ports.api; } } new Box().client.health();",
      "view-api",
    ],
    [
      "class Box { client: any; run() { this.client ??= context.queryClient; this.client.clear(); } } new Box().run();",
      "view-state",
    ],
    [
      "class Box { client: any; constructor() { [this.client] = [context.ports.api]; } } new Box().client.health();",
      "view-api",
    ],
    [
      "class Box { client: any; constructor() { ({ value: this.client } = { value: context.ports.api }); } } new Box().client.health();",
      "view-api",
    ],
    [
      "class Box { client: any = context.ports.api; } const b = new Box(); b.client.health();",
      "view-api",
    ],
    [
      "class Box { client: any = context.queryClient; } const b = new Box(); b.client.clear();",
      "view-state",
    ],
    [
      "class Box { static client: any = context.ports.api; } Box.client.health();",
      "view-api",
    ],
    [
      "class Box { #client: any = context.ports.api; run() { this.#client.health(); } } new Box().run();",
      "view-api",
    ],
    [
      "class Box { nested: any = { ports: context.ports }; } new Box().nested.ports.api.health();",
      "view-api",
    ],
    [
      "const Box = class { ['client']: any = context.queryClient; }; new Box().client.clear();",
      "view-state",
    ],
  ]);
});

test("loop, comma and class flows preserve harmless values and context helpers", () => {
  const inputs = {
    "contexts/lint-flow/read.ts":
      "export function read(api: any) { return { health() {} }; }",
    "views/lint-flow/Page.ts": `import { useRouteContext } from '@tanstack/react-router';
      import { read } from '../../contexts/lint-flow/read.js';
      const context: any = useRouteContext({ strict: false });
      for (const api of [{ health() {} }]) api.health();
      for (const { nested: [api] } of [{ nested: [{ health() {} }] }]) api!.health();
      for (const api of [context.ports.api]) read(api);
      const api = (context.ports.api, { health() {} }); api.health();
      const safe = (Math.random(), { health() {} }); safe.health();
      class Box { client = read(context.ports.api); static count = 1; }
      new Box().client.health();
      class Owned { client: any; constructor() { this.client = read(context.ports.api); } }
      new Owned().client.health();
      { const context = { ports: { api: { health() {} } } }; class Local { client = context.ports.api; } new Local().client.health(); }
      for (const key of ['tenantId'] as const) { const tenant = context[key]; }
    `,
    "routes/dashboard.tsx": readFileSync(
      resolve(webRoot, "src/routes/dashboard.tsx"),
      "utf8",
    ).replace(
      /  loader:.*\n/,
      `  loader: ({ context }) => { for (const deps of [context]) prefetchDashboard(deps); const tenant = (Math.random(), context.tenantId); class Value { id = tenant; } return new Value().id; },\n`,
    ),
  };
  const results = check(inputs, {}, true);
  assert.deepEqual(
    results.compilerDiagnostics.map((d) =>
      ts.flattenDiagnosticMessageText(d.messageText, "\n"),
    ),
    [],
  );
  assert.deepEqual([...results], []);
});


test("reused source syntax keeps context helper parameter bindings independent", () => {
  const helper = "export function read(value: any): any { const box: any = {}; box.value = value; return box.value; }";
  checkReviewForms("source-snapshot-binding-isolation", [
    ["read({ health() {} }).health(); read(context.ports.api).health();", "view-api"],
    ["read({ clear() {} }).clear(); read(context.queryClient).clear();", "view-state"],
  ], { "contexts/lint-reuse/read.ts": helper }, "import { read } from '@/contexts/lint-reuse/read.js';\n");
  const results = check({
    "contexts/lint-reuse/read.ts": helper,
    "views/lint-reuse/Page.ts": "import { read } from '../../contexts/lint-reuse/read.js'; read({ health() {} }).health(); read({ clear() {} }).clear();",
  }, {}, true);
  assert.equal(results.compilerDiagnostics.length, 0);
  assert.deepEqual([...results], []);
});
