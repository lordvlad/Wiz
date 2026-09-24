import { join } from 'node:path';
import { addPreload, type PreloadSection } from './bunfig.ts';

export const PLUGIN_FILE = 'wizPlugin.ts';
export const BUNFIG_FILE = 'bunfig.toml';

const PLUGIN_SOURCE = `import { plugin } from "bun";
import { wizPlugin } from "wiz/plugin";

// Registered before your code loads, so wiz can rewrite the type helpers as
// each module is transpiled. Pass a logger to change where diagnostics go.
plugin(wizPlugin());
`;

export interface InitOptions {
  cwd?: string;
  /** Overwrite an existing plugin file instead of leaving it alone. */
  force?: boolean;
}

export interface InitResult {
  /** One human-readable line per file considered. */
  notes: string[];
  changed: boolean;
}

/**
 * Sets a project up for wiz: a preload that registers the plugin, and the
 * `bunfig.toml` entries that make `bun run` and `bun test` load it.
 *
 * Re-running is safe; anything already in place is reported and left alone.
 */
export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const cwd = options.cwd ?? process.cwd();
  const notes: string[] = [];
  let changed = false;

  const pluginPath = join(cwd, PLUGIN_FILE);
  const pluginFile = Bun.file(pluginPath);

  if ((await pluginFile.exists()) && !options.force) {
    notes.push(`${PLUGIN_FILE} already exists, left alone (use --force to replace it)`);
  } else {
    await Bun.write(pluginPath, PLUGIN_SOURCE);
    notes.push(`wrote ${PLUGIN_FILE}`);
    changed = true;
  }

  const bunfigPath = join(cwd, BUNFIG_FILE);
  const bunfigFile = Bun.file(bunfigPath);
  const existed = await bunfigFile.exists();
  const original = existed ? await bunfigFile.text() : '';

  // `bun run` reads the root table and `bun test` reads `[test]`; a project
  // wants the plugin in both, and neither implies the other.
  const sections: PreloadSection[] = ['', 'test'];
  let source = original;
  const added: string[] = [];

  for (const section of sections) {
    const edit = addPreload(source, `./${PLUGIN_FILE}`, section);
    source = edit.source;
    if (edit.changed) {
      added.push(section === '' ? 'preload' : `[test] preload`);
    }
  }

  if (source !== original) {
    await Bun.write(bunfigPath, source);
    notes.push(`${existed ? 'updated' : 'created'} ${BUNFIG_FILE} (${added.join(', ')})`);
    changed = true;
  } else {
    notes.push(`${BUNFIG_FILE} already preloads ./${PLUGIN_FILE}`);
  }

  // The preload now runs on every bun command in this project, so an
  // unresolvable import would turn into a module error on all of them.
  try {
    Bun.resolveSync('wiz/plugin', cwd);
  } catch {
    notes.push(
      `warning: 'wiz' does not resolve from here yet - run 'bun add wiz', or bun will fail to load ${PLUGIN_FILE}`
    );
  }

  return { notes, changed };
}
