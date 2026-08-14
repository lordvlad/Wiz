#!/usr/bin/env bun
import { runInit } from "./cli/init.ts";
import { ejectFile, ejectProject, writeEjected } from "./cli/eject.ts";
import { consoleLogger, silentLogger } from "./logger.ts";

const USAGE = `wiz - compile-time type introspection for Bun

Usage:
  wiz init [--force]              Register the plugin in the current project
  wiz eject <file.ts> [out.ts]    Eject one file; no output path prints to stdout
  wiz eject <dir> [outdir]        Eject a tsconfig project; no outdir prints JSON
  wiz --help                      Show this message

init writes wizPlugin.ts and points bunfig.toml at it, for both 'bun run'
and 'bun test'. It is safe to re-run; --force replaces an existing
wizPlugin.ts rather than leaving it alone.

eject writes what the plugin would have handed to Bun: the rewritten source
plus the generated modules it imports. A single file is ejected on its own and
fails if anything in it needs to read another file; a directory is ejected
through its tsconfig.json, which is what makes that traversal available.
Existing files are overwritten.
`;

/** A single file ejects to one self-contained file, so stdout always works. */
async function ejectOne(input: string, output: string | undefined): Promise<number> {
  const contents = await Bun.file(input).text();
  const code = ejectFile(input, contents, output ? consoleLogger : silentLogger);

  if (!output) {
    process.stdout.write(code);
    return 0;
  }

  await Bun.write(output, code);
  console.log(`  ${output}`);
  return 0;
}

async function ejectDir(input: string, output: string | undefined): Promise<number> {
  const files = ejectProject(input, output ? consoleLogger : silentLogger);

  if (!output) {
    // Keys are paths, values are contents, so the whole tree is one JSON value.
    const tree: Record<string, string> = {};
    for (const file of files) tree[file.path] = file.contents;
    process.stdout.write(`${JSON.stringify(tree, null, 2)}\n`);
    return 0;
  }

  await writeEjected(output, files);
  for (const file of files) console.log(`  ${file.path}`);
  return 0;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === "init") {
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

  if (command === "eject") {
    const [input, output, ...extra] = rest;
    if (!input) {
      console.error("wiz eject: needs a file or directory to eject");
      return 1;
    }
    if (extra.length > 0) {
      console.error(`wiz eject: unexpected argument '${extra[0]}'`);
      return 1;
    }

    try {
      const stat = await Bun.file(input).stat();
      return stat.isDirectory()
        ? await ejectDir(input, output)
        : await ejectOne(input, output);
    } catch (error) {
      console.error(`wiz eject: ${(error as Error).message}`);
      return 1;
    }
  }

  console.error(`wiz: unknown command '${command}'\n`);
  console.error(USAGE);
  return 1;
}

process.exit(await main(process.argv.slice(2)));
