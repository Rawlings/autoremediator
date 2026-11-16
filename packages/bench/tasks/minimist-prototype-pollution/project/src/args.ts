import minimist from "minimist";

export interface Options {
  port: number;
  verbose: boolean;
  files: string[];
}

/** Command line of the form `tool [-p <port>] [-v] <file>...`. */
export function parseArgs(argv: string[]): Options {
  const args = minimist(argv, {
    boolean: ["verbose"],
    alias: { v: "verbose", p: "port" },
    default: { port: 8080 },
  });
  return { port: Number(args["port"]), verbose: Boolean(args["verbose"]), files: args._.map(String) };
}
