// @wiz-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPreload } from "../src/cli/bunfig.ts";
import { BUNFIG_FILE, PLUGIN_FILE, runInit } from "../src/cli/init.ts";

const ENTRY = "./wizPlugin.ts";

/** Every result must still parse, or we have corrupted someone's config. */
function reparse(source: string): Record<string, any> {
  return Bun.TOML.parse(source) as Record<string, any>;
}

describe("adding a preload entry", () => {
  test("creates the key in an empty file", () => {
    const { source, changed } = addPreload("", ENTRY, "");
    expect(changed).toBe(true);
    expect(reparse(source).preload).toEqual([ENTRY]);
  });

  test("extends an existing array", () => {
    const { source } = addPreload(`preload = ["./a.ts"]\n`, ENTRY, "");
    expect(reparse(source).preload).toEqual(["./a.ts", ENTRY]);
  });

  test("promotes a bare string to an array", () => {
    const { source } = addPreload(`preload = "./a.ts"\n`, ENTRY, "");
    expect(reparse(source).preload).toEqual(["./a.ts", ENTRY]);
  });

  test("fills an empty array", () => {
    const { source } = addPreload(`preload = []\n`, ENTRY, "");
    expect(reparse(source).preload).toEqual([ENTRY]);
  });

  test("extends a multi-line array, keeping its indentation", () => {
    const source = addPreload(
      ['preload = [', '    "./a.ts",', '    "./b.ts",', ']', ''].join("\n"),
      ENTRY,
      ""
    ).source;
    expect(reparse(source).preload).toEqual(["./a.ts", "./b.ts", ENTRY]);
    expect(source).toContain(`    "${ENTRY}",`);
  });

  test("extends a multi-line array with no trailing comma", () => {
    const source = addPreload(
      ["preload = [", '  "./a.ts"', "]", ""].join("\n"),
      ENTRY,
      ""
    ).source;
    expect(reparse(source).preload).toEqual(["./a.ts", ENTRY]);
  });

  test("is a no-op when already listed", () => {
    const original = `preload = ["${ENTRY}"]\n`;
    const { source, changed } = addPreload(original, ENTRY, "");
    expect(changed).toBe(false);
    expect(source).toBe(original);
  });

  test("treats a path with and without ./ as the same entry", () => {
    const { changed } = addPreload(`preload = ["wizPlugin.ts"]\n`, ENTRY, "");
    expect(changed).toBe(false);
  });

  test("keeps comments, ordering and unrelated keys", () => {
    const original = [
      "# my config",
      'telemetry = false',
      "",
      "[install]",
      'registry = "https://example.com"',
      "",
    ].join("\n");
    const { source } = addPreload(original, ENTRY, "");

    expect(source).toContain("# my config");
    expect(source).toContain("telemetry = false");
    const parsed = reparse(source);
    expect(parsed.preload).toEqual([ENTRY]);
    expect(parsed.install.registry).toBe("https://example.com");
  });

  test("a root key lands before the first section, not inside it", () => {
    const { source } = addPreload(`[install]\nregistry = "x"\n`, ENTRY, "");
    // Inserted after `[install]` it would become install.preload.
    expect(reparse(source).preload).toEqual([ENTRY]);
    expect(reparse(source).install.preload).toBeUndefined();
  });

  test("a ] inside a string does not end the array early", () => {
    const { source } = addPreload(`preload = ["./we[ird].ts"]\n`, ENTRY, "");
    expect(reparse(source).preload).toEqual(["./we[ird].ts", ENTRY]);
  });

  test("a trailing comment survives", () => {
    const { source } = addPreload(`preload = ["./a.ts"] # keep me\n`, ENTRY, "");
    expect(reparse(source).preload).toEqual(["./a.ts", ENTRY]);
    expect(source).toContain("# keep me");
  });

  describe("the test section", () => {
    test("is created when absent", () => {
      const { source } = addPreload("", ENTRY, "test");
      expect(reparse(source).test.preload).toEqual([ENTRY]);
    });

    test("reuses an existing [test] header", () => {
      const { source } = addPreload(`[test]\nroot = "./src"\n`, ENTRY, "test");
      const parsed = reparse(source);
      expect(parsed.test.preload).toEqual([ENTRY]);
      expect(parsed.test.root).toBe("./src");
      expect(source.match(/\[test\]/g)).toHaveLength(1);
    });

    test("finds the dotted form", () => {
      const original = `test.preload = ["${ENTRY}"]\n`;
      expect(addPreload(original, ENTRY, "test").changed).toBe(false);
    });

    test("extends the dotted form", () => {
      const { source } = addPreload(`test.preload = ["./a.ts"]\n`, ENTRY, "test");
      expect(reparse(source).test.preload).toEqual(["./a.ts", ENTRY]);
    });

    test("does not confuse the root key with the test key", () => {
      const { source } = addPreload(`preload = ["./a.ts"]\n`, ENTRY, "test");
      const parsed = reparse(source);
      expect(parsed.preload).toEqual(["./a.ts"]);
      expect(parsed.test.preload).toEqual([ENTRY]);
    });
  });
});

describe("wiz init", () => {
  const dirs: string[] = [];

  const workspace = async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiz-init-"));
    dirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  test("writes the plugin file and both preloads", async () => {
    const cwd = await workspace();
    const result = await runInit({ cwd });

    expect(result.changed).toBe(true);
    const plugin = await Bun.file(join(cwd, PLUGIN_FILE)).text();
    expect(plugin).toContain(`from "wiz/plugin"`);
    expect(plugin).toContain("plugin(wizPlugin())");

    const parsed = reparse(await Bun.file(join(cwd, BUNFIG_FILE)).text());
    expect(parsed.preload).toEqual([`./${PLUGIN_FILE}`]);
    expect(parsed.test.preload).toEqual([`./${PLUGIN_FILE}`]);
  });

  test("is idempotent", async () => {
    const cwd = await workspace();
    await runInit({ cwd });
    const first = await Bun.file(join(cwd, BUNFIG_FILE)).text();

    const second = await runInit({ cwd });
    expect(second.changed).toBe(false);
    expect(await Bun.file(join(cwd, BUNFIG_FILE)).text()).toBe(first);
    expect(second.notes.join(" ")).toContain("already");
  });

  test("leaves an existing plugin file alone unless forced", async () => {
    const cwd = await workspace();
    await Bun.write(join(cwd, PLUGIN_FILE), "// mine\n");

    await runInit({ cwd });
    expect(await Bun.file(join(cwd, PLUGIN_FILE)).text()).toBe("// mine\n");

    await runInit({ cwd, force: true });
    expect(await Bun.file(join(cwd, PLUGIN_FILE)).text()).toContain("wizPlugin");
  });

  test("warns when wiz cannot be resolved from the project", async () => {
    // Left unsaid, this surfaces as a module error on every later bun command.
    const cwd = await workspace();
    const result = await runInit({ cwd });
    expect(result.notes.join("\n")).toContain("bun add wiz");
  });

  test("merges into a config that already has content", async () => {
    const cwd = await workspace();
    await Bun.write(
      join(cwd, BUNFIG_FILE),
      ['# keep\npreload = ["./other.ts"]\n', "[test]\nroot = \"./spec\"\n"].join("\n")
    );

    await runInit({ cwd });
    const text = await Bun.file(join(cwd, BUNFIG_FILE)).text();
    const parsed = reparse(text);

    expect(text).toContain("# keep");
    expect(parsed.preload).toEqual(["./other.ts", `./${PLUGIN_FILE}`]);
    expect(parsed.test.root).toBe("./spec");
    expect(parsed.test.preload).toEqual([`./${PLUGIN_FILE}`]);
  });
});

describe("the wiz binary", () => {
  const run = async (args: string[], cwd: string) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  };

  test("init sets the project up end to end", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wiz-cli-"));
    try {
      const result = await run(["init"], cwd);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(PLUGIN_FILE);

      const parsed = reparse(await Bun.file(join(cwd, BUNFIG_FILE)).text());
      expect(parsed.preload).toEqual([`./${PLUGIN_FILE}`]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("an unknown command fails with usage", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wiz-cli-"));
    try {
      const result = await run(["nope"], cwd);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unknown command");
      expect(result.stderr).toContain("Usage:");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("--help succeeds", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "wiz-cli-"));
    try {
      const result = await run(["--help"], cwd);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("wiz init");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

const TSCONFIG_JSON = JSON.stringify({
  compilerOptions: {
    target: "ESNext",
    module: "Preserve",
    moduleResolution: "bundler",
    strict: true,
    noEmit: true,
    allowImportingTsExtensions: true,
  },
  include: ["src"],
});

describe("wiz eject through the binary", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  const workspace = async () => {
    const dir = await mkdtemp(join(tmpdir(), "wiz-eject-cli-"));
    scratch.push(dir);
    return dir;
  };

  const run = async (args: string[], cwd: string) => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  };

  const SOURCE = `import { keysOf } from "wiz";
export interface User { name: string }
export const keys = keysOf<User>();
`;

  test("one file with no output path prints to stdout", async () => {
    const cwd = await workspace();
    await Bun.write(join(cwd, "one.ts"), SOURCE);

    const result = await run(["eject", "one.ts"], cwd);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("export const keys =");
    expect(result.stdout).not.toMatch(/from\s+"wiz"/);
  });

  test("one file with an output path writes it, overwriting", async () => {
    const cwd = await workspace();
    await Bun.write(join(cwd, "one.ts"), SOURCE);
    await Bun.write(join(cwd, "out.ts"), "// stale\n");

    const result = await run(["eject", "one.ts", "out.ts"], cwd);
    expect(result.code).toBe(0);

    const written = await Bun.file(join(cwd, "out.ts")).text();
    expect(written).not.toContain("stale");
    expect(written).toContain("export const keys =");
  });

  test("a directory with no outdir prints a JSON tree keyed by path", async () => {
    const cwd = await workspace();
    await Bun.write(join(cwd, "tsconfig.json"), TSCONFIG_JSON);
    await Bun.write(join(cwd, "src", "one.ts"), SOURCE);

    const result = await run(["eject", "."], cwd);
    expect(result.code).toBe(0);

    const tree = JSON.parse(result.stdout) as Record<string, string>;
    expect(Object.keys(tree)).toContain("src/one.ts");
    expect(tree["src/one.ts"]).toContain("export const keys =");
  });

  test("a directory with an outdir mirrors the tree", async () => {
    const cwd = await workspace();
    await Bun.write(join(cwd, "tsconfig.json"), TSCONFIG_JSON);
    await Bun.write(join(cwd, "src", "one.ts"), SOURCE);

    const result = await run(["eject", ".", "dist"], cwd);
    expect(result.code).toBe(0);
    expect(await Bun.file(join(cwd, "dist", "src", "one.ts")).exists()).toBe(true);
  });

  test("eject needs something to eject", async () => {
    const cwd = await workspace();
    const result = await run(["eject"], cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("needs a file or directory");
  });

  test("a project eject without a tsconfig is refused", async () => {
    const cwd = await workspace();
    const result = await run(["eject", "."], cwd);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("no tsconfig.json");
  });
});
