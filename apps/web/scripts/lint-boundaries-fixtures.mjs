import { createHash } from "node:crypto";
import { resolve } from "node:path";
import ts from "typescript";
import { lintProgram, webRoot } from "./lint-boundaries.mjs";

// Separate compiler configurations never share a builder or syntax cache.
// Versions bind reuse to current bytes, including files read from disk.
const compilers = new Map();

export function check(files, exemptions = {}, realProgram = false) {
  const sources = new Map(
    Object.entries(files).map(([path, source]) => [
      resolve(webRoot, "src", path),
      source,
    ]),
  );
  const parsed = realProgram
    ? ts.parseJsonConfigFileContent(
        ts.readConfigFile(resolve(webRoot, "tsconfig.json"), ts.sys.readFile).config,
        ts.sys,
        webRoot,
      )
    : undefined;
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
  const key = JSON.stringify({ realProgram, options });
  if (!compilers.has(key)) compilers.set(key, { files: new Map() });
  const compiler = compilers.get(key);
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
  // Added, removed and changed overlays can change module resolution even when
  // an importing production file has identical text. Never reuse resolutions.
  host.hasInvalidatedResolutions = () => true;
  host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) => {
    const text = host.readFile(path);
    const cacheKey = JSON.stringify([path, languageVersion]);
    const previous = compiler.files.get(cacheKey);
    if (!shouldCreateNewSourceFile && text !== undefined && previous?.text === text)
      return previous;
    const source = sources.has(path)
      ? ts.createSourceFile(path, text, languageVersion, true)
      : getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
    if (source) {
      source.version = createHash("sha256").update(source.text).digest("hex");
      compiler.files.set(cacheKey, source);
    } else compiler.files.delete(cacheKey);
    return source;
  };
  const builder = ts.createSemanticDiagnosticsBuilderProgram(
    realProgram
      ? [...new Set([...parsed.fileNames, ...sources.keys()])]
      : [...sources.keys()],
    options,
    host,
    compiler.builder,
  );
  compiler.builder = builder;
  const program = builder.getProgram();
  // Ignore unrelated real imported production files; the fixture owns its source set.
  const scoped = {
    getTypeChecker: () => program.getTypeChecker(),
    getCompilerOptions: () => options,
    getSourceFile: (path) => program.getSourceFile(path),
    getSourceFiles: () =>
      program.getSourceFiles().filter((source) => sources.has(source.fileName)),
  };
  const results = lintProgram(scoped, webRoot, exemptions);
  // Compiler diagnostics remain independent evidence for the current program.
  if (realProgram) results.compilerDiagnostics = builder.getSemanticDiagnostics();
  return results;
}
export const rules = (results) =>
  [...new Set(results.map((result) => result.rule))].sort();
