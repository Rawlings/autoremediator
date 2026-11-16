/**
 * Autoremediator Dagger module.
 *
 * Runs the autoremediator CLI inside a container against a directory and returns the remediated
 * directory (or the JSON report). Nothing is pushed and no pull request is opened: export the
 * result and review the diff.
 *
 *   dagger call -m ./dagger remediate --source . export --path .
 *   dagger call -m ./dagger report --source . contents
 *
 * NOTE: this module has not been executed against a Dagger engine. See docs/integrations/other-ci.md.
 */
import { dag, Container, Directory, File, object, func, argument } from "@dagger.io/dagger";

const WORKDIR = "/workdir";

@object()
export class Autoremediator {
  /**
   * A container with the autoremediator CLI installed and `source` mounted as the working
   * directory. Use it to run any other CLI subcommand with `terminal` or `with-exec`.
   *
   * @param source Project directory to operate on
   * @param version npm version range of autoremediator to install
   * @param nodeVersion Node.js image tag (26 or later)
   */
  @func()
  container(
    @argument({ defaultPath: "/", ignore: ["**/node_modules", ".git"] }) source: Directory,
    version = "^0.22.0",
    nodeVersion = "26",
  ): Container {
    return dag
      .container()
      .from(`node:${nodeVersion}`)
      .withMountedCache("/root/.npm", dag.cacheVolume("autoremediator-npm"))
      .withExec(["npm", "install", "--global", `autoremediator@${version}`])
      .withDirectory(WORKDIR, source)
      .withWorkdir(WORKDIR);
  }

  /**
   * Remediate vulnerabilities found by the package manager's audit and return the changed project
   * directory. Pass `--run-tests`, `--policy <path>` or other CLI flags through `args`.
   *
   * @param source Project directory to remediate
   * @param version npm version range of autoremediator to install
   * @param nodeVersion Node.js image tag (26 or later)
   * @param args Extra autoremediator CLI flags
   */
  @func()
  remediate(
    @argument({ defaultPath: "/", ignore: ["**/node_modules", ".git"] }) source: Directory,
    version = "^0.22.0",
    nodeVersion = "26",
    args: string[] = [],
  ): Directory {
    return this.container(source, version, nodeVersion)
      .withExec(["autoremediator", "--audit", "--output-format", "json", ...args], {
        redirectStdout: "/tmp/autoremediator-report.json",
      })
      .directory(WORKDIR);
  }

  /**
   * Run the audit remediation and return the JSON report instead of the changed files.
   *
   * @param source Project directory to remediate
   * @param version npm version range of autoremediator to install
   * @param nodeVersion Node.js image tag (26 or later)
   * @param args Extra autoremediator CLI flags
   */
  @func()
  report(
    @argument({ defaultPath: "/", ignore: ["**/node_modules", ".git"] }) source: Directory,
    version = "^0.22.0",
    nodeVersion = "26",
    args: string[] = [],
  ): File {
    return this.container(source, version, nodeVersion)
      .withExec(["autoremediator", "--audit", "--output-format", "json", ...args], {
        redirectStdout: "/tmp/autoremediator-report.json",
      })
      .file("/tmp/autoremediator-report.json");
  }
}
