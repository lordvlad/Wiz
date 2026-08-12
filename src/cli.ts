#!/usr/bin/env bun
import { runInit } from "./cli/init.ts";

const USAGE = `wiz - compile-time type introspection for Bun

Usage:
  wiz init [--force]   Register the plugin in the current project
  wiz --help           Show this message

init writes wizPlugin.ts and points bunfig.toml at it, for both 'bun run'
and 'bun test'. It is safe to re-run; --force replaces an existing
wizPlugin.ts rather than leaving it alone.
`;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command !== "init") {
    console.error(`wiz: unknown command '${command}'\n`);
    console.error(USAGE);
    return 1;
  }

  const unknown = rest.filter((flag) => flag !== "--force" && flag !== "-f");
  if (unknown.length > 0) {
    console.error(`wiz init: unknown option '${unknown[0]}'`);
    return 1;
  }

  try {
    const result = await runInit({ force: rest.length > 0 });
    for (const note of result.notes) console.log(`  ${note}`);
    console.log(
      result.changed
        ? "\nDone. Bun will load the plugin on the next run."
        : "\nAlready set up; nothing to do."
    );
    return 0;
  } catch (error) {
    console.error(`wiz init: ${(error as Error).message}`);
    return 1;
  }
}

process.exit(await main(process.argv.slice(2)));
