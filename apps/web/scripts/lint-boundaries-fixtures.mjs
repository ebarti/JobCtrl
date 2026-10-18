import { resolve } from "node:path";
import ts from "typescript";
import { lintProgram, webRoot } from "./lint-boundaries.mjs";

export function check(files, exemptions = {}, realProgram = false) {
  const sources = new Map(
    Object.entries(files).map(([path, source]) => [
      resolve(webRoot, "src", path),
      source,
    ]),
  );
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(resolve(webRoot, "tsconfig.json"), ts.sys.readFile)
      .config,
    ts.sys,
    webRoot,
  );
  const options = realProgram
    ? parsed.options
    : {
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
  const program = ts.createProgram(
    realProgram
      ? [...new Set([...parsed.fileNames, ...sources.keys()])]
      : [...sources.keys()],
    options,
    host,
  );
  // Ignore unrelated real imported production files; the fixture owns its source set.
  const scoped = {
    getTypeChecker: () => program.getTypeChecker(),
    getCompilerOptions: () => options,
    getSourceFile: (path) => program.getSourceFile(path),
    getSourceFiles: () =>
      program.getSourceFiles().filter((source) => sources.has(source.fileName)),
  };
  const results = lintProgram(scoped, webRoot, exemptions);
  // Compiler diagnostics are evidence only, never a substitute for boundary diagnostics.
  if (realProgram)
    results.compilerDiagnostics = program.getSemanticDiagnostics();
  return results;
}
export const rules = (results) =>
  [...new Set(results.map((result) => result.rule))].sort();
