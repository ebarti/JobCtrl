import { format } from "node:util";

import {
  executeJobDataPurge,
  inspectJobDataPurge,
  JOB_DATA_PURGE_CONFIRMATION,
  type JobDataPurgePlan,
} from "./job-data-purge.js";

type CliOptions = {
  appDir?: string;
  confirmation?: string;
  help: boolean;
};

function usage(): string {
  return `Usage:
  corepack pnpm data:purge-jobs [--app-dir PATH]
  corepack pnpm data:purge-jobs [--app-dir PATH] --confirm ${JOB_DATA_PURGE_CONFIRMATION}

Without --confirm, the command performs a read-only inventory. The confirmed
command requires JobCtrl to be stopped, creates a recoverable database and
generated-files backup, purges the complete local Job graph, empties the live
tailored_resumes/ and cover_letters/ directories, compacts SQLite, and verifies
that profile, resume-template, Discovery settings, and Settings data did not change.`;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: CliOptions = { help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--app-dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--app-dir requires a path.");
      options.appDir = value;
      index += 1;
      continue;
    }
    if (argument === "--confirm") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--confirm requires the exact confirmation phrase.");
      options.confirmation = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function bytes(value: number): string {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    style: "unit",
    unit: value >= 1_000_000_000 ? "gigabyte" : value >= 1_000_000 ? "megabyte" : "kilobyte",
    unitDisplay: "short",
  }).format(value >= 1_000_000_000 ? value / 1_000_000_000 : value >= 1_000_000 ? value / 1_000_000 : value / 1_000);
}

function planLines(plan: JobDataPurgePlan): string[] {
  return [
    `Workspace: ${plan.appDir}`,
    `Database: ${plan.databasePath} (${bytes(plan.databaseBytes)})`,
    `Jobs: ${plan.jobCount}`,
    `Job and Discovery execution/history rows: ${plan.jobOperationRows}`,
    `Registered artifact rows: ${plan.registeredArtifactRows} (${plan.materialArtifactRows} Materials rows)`,
    `Generated files to archive: ${plan.generatedFiles} (${bytes(plan.generatedBytes)})`,
    `Registered generated log files to archive: ${plan.registeredLogFileCount}`,
    `Registered files already missing: ${plan.registeredMissingFileCount}`,
    `Active stages/workflows: ${plan.activeStageCount}/${plan.activeWorkflowCount}`,
  ];
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const purgeOptions = options.appDir === undefined ? {} : { appDir: options.appDir };
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.confirmation === undefined) {
    const plan = inspectJobDataPurge(purgeOptions);
    console.log(planLines(plan).join("\n"));
    console.log("\nRead-only inventory complete; nothing was changed.");
    console.log(`Stop JobCtrl, then rerun with --confirm ${JOB_DATA_PURGE_CONFIRMATION} to execute.`);
    return;
  }
  if (options.confirmation !== JOB_DATA_PURGE_CONFIRMATION) {
    throw new Error(`Confirmation did not match ${JOB_DATA_PURGE_CONFIRMATION}; nothing was changed.`);
  }

  const result = executeJobDataPurge(purgeOptions);
  console.log(planLines(result).join("\n"));
  if (result.noOp) {
    console.log("\nNo live jobs, generated material, or job execution history remained; nothing was changed.");
    return;
  }
  console.log(
    `\nPurged ${result.jobsDeleted} jobs and ${result.jobOperationRowsDeleted} job execution/history rows; `
    + `archived ${result.movedGeneratedFiles} generated files.`,
  );
  console.log(`Compacted database: ${bytes(result.databaseBytes)} -> ${bytes(result.logicalDatabaseBytesAfter)}.`);
  console.log(`Recovery bundle: ${result.backupDirectory}`);
  console.log("Verified: zero live jobs/artifact/execution rows, empty generated-material directories, SQLite integrity, and unchanged profile/search/settings data.");
}

try {
  main();
} catch (error) {
  console.error(format(error instanceof Error ? error.message : error));
  process.exitCode = 1;
}
