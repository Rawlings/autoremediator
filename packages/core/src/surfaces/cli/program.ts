import { Command } from "commander";

import { PACKAGE_VERSION } from "../../shared/version.js";
import {
  registerDiffCommand,
  registerEvaluateCommand,
  registerReachabilityCommand,
} from "./commands/analysis.js";
import { registerAssessCommands } from "./commands/assess.js";
import { registerAutonomyCommands } from "./commands/autonomy.js";
import { registerBisectCommand } from "./commands/bisect.js";
import { registerDietCommand } from "./commands/diet.js";
import { registerEvidencePackCommands } from "./commands/evidence-pack.js";
import { registerFreshnessCommands } from "./commands/freshness.js";
import { registerGuardCommand, registerGuardHookCommand } from "./commands/guard.js";
import { registerHookCommands } from "./commands/hooks.js";
import { registerIncidentCommands } from "./commands/incident.js";
import { registerInitCommand } from "./commands/init.js";
import { registerMaintainCommands } from "./commands/maintain.js";
import { registerMemoryCommands } from "./commands/memory.js";
import { registerPatchesCommands } from "./commands/patches.js";
import { registerPolicyCommands } from "./commands/policy.js";
import { registerProveCommands } from "./commands/prove.js";
import { registerRadarCommands } from "./commands/radar.js";
import { addRecipesCommand } from "./commands/recipes.js";
import { registerDefaultCommand, registerRemediateCommands } from "./commands/remediate.js";
import { registerRunsCommands } from "./commands/runs.js";
import { registerTraceCommands } from "./commands/trace.js";
import { registerTriageCommand } from "./commands/triage.js";

export function createProgram(): Command {
  const program = new Command();
  program
    .name("autoremediator")
    .description(
      "Agentic remediation for Node.js dependencies: plan the fix, repair what it breaks, verify, roll back on failure",
    )
    .version(PACKAGE_VERSION)
    // Root options are only valid before a subcommand. Without this, the root swallows flags such as
    // `--cwd` and `--output-format` typed after `reachability`/`diff`/`patches`, and the subcommand
    // silently runs with its defaults.
    .enablePositionalOptions()
    .showHelpAfterError();
  registerRemediateCommands(program);
  registerGuardCommand(program);
  registerDietCommand(program);
  registerGuardHookCommand(program);
  registerIncidentCommands(program);
  registerPolicyCommands(program);
  registerMaintainCommands(program);
  registerProveCommands(program);
  registerRadarCommands(program);
  registerFreshnessCommands(program);
  registerMemoryCommands(program);
  registerEvidencePackCommands(program);
  registerInitCommand(program);
  registerHookCommands(program);
  registerRunsCommands(program);
  addRecipesCommand(program);
  registerAutonomyCommands(program);
  registerPatchesCommands(program);
  registerReachabilityCommand(program);
  registerTraceCommands(program);
  registerEvaluateCommand(program);
  registerAssessCommands(program);
  registerDiffCommand(program);
  registerBisectCommand(program);
  registerTriageCommand(program);
  registerDefaultCommand(program);
  return program;
}
