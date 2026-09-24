/**
 * Adding a preload entry to `bunfig.toml`.
 *
 * `Bun.TOML.parse` decides what is already there — it understands dotted keys,
 * quoting and the string-or-array shape of `preload`, none of which is worth
 * re-deriving with regexes. There is no matching serializer, though, so the
 * write is a text edit: round-tripping through a parser we would have to
 * write ourselves would strip the comments and ordering out of a file the user
 * owns.
 */

/** `bun run` reads the root table; `bun test` reads `[test]`. */
export type PreloadSection = '' | 'test';

export interface PreloadEdit {
  source: string;
  changed: boolean;
}

/** `./plugin.ts` and `plugin.ts` name the same file. */
function samePath(a: string, b: string): boolean {
  const strip = (p: string) => p.replace(/^\.\//, '');
  return strip(a) === strip(b);
}

/** The entries `preload` already lists for a section, or undefined if unset. */
function declaredPreload(source: string, section: PreloadSection): string[] | undefined {
  const parsed = Bun.TOML.parse(source) as Record<string, unknown>;
  const table = section === '' ? parsed : (parsed[section] as Record<string, unknown> | undefined);
  const value = table?.['preload'];

  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  return undefined;
}

/**
 * Scans forward from `open` for the bracket that closes it, skipping over
 * string contents so a `]` inside a path or comment cannot end the array early.
 */
function findClosingBracket(text: string, open: number): number | undefined {
  let depth = 0;
  let quote: string | undefined;

  for (let i = open; i < text.length; i++) {
    const char = text[i]!;

    if (quote) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      // A comment runs to the end of its line.
      const newline = text.indexOf('\n', i);
      if (newline === -1) {
        return undefined;
      }
      i = newline;
    } else if (char === '[') {
      depth++;
    } else if (char === ']') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return undefined;
}

/** The offset of the `preload` assignment's value, if it can be located. */
function findAssignment(
  source: string,
  section: PreloadSection
): { valueStart: number } | undefined {
  const lines = source.split('\n');
  const wanted = section === '' ? 'preload' : `${section}.preload`;
  let current = '';
  let offset = 0;

  for (const line of lines) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) {
      current = header[1]!.trim();
      offset += line.length + 1;
      continue;
    }

    const assignment = /^\s*(?:"([^"]+)"|([A-Za-z0-9_.-]+))\s*=/.exec(line);
    if (assignment) {
      const key = assignment[1] ?? assignment[2]!;
      const qualified = current === '' ? key : `${current}.${key}`;
      if (qualified === wanted) {
        return { valueStart: offset + line.indexOf('=') + 1 };
      }
    }
    offset += line.length + 1;
  }
  return undefined;
}

/** Extends an existing `preload` value with one more entry. */
function extendAssignment(source: string, valueStart: number, entry: string): string {
  const rest = source.slice(valueStart);
  const leading = rest.length - rest.trimStart().length;
  const valueAt = valueStart + leading;

  if (source[valueAt] === '[') {
    const close = findClosingBracket(source, valueAt);
    if (close === undefined) {
      throw new Error("the 'preload' array is not closed");
    }
    const inner = source.slice(valueAt + 1, close);
    const multiline = inner.includes('\n');

    if (inner.trim() === '') {
      return `${source.slice(0, valueAt)}["${entry}"]${source.slice(close + 1)}`;
    }
    if (multiline) {
      // Match the indentation the existing entries already use.
      const indent = /\n(\s*)\S/.exec(inner)?.[1] ?? '  ';
      const trailingComma = /,\s*$/.test(inner);
      const separator = trailingComma ? '' : ',';
      return `${source.slice(0, close)}${separator}\n${indent}"${entry}",\n${source.slice(close)}`;
    }
    return `${source.slice(0, close)}, "${entry}"${source.slice(close)}`;
  }

  // A bare string: `preload = "./a.ts"` becomes a two-element array.
  const end = /^\s*(?:"(?:[^"\\]|\\.)*"|'[^']*')/.exec(rest);
  if (!end) {
    throw new Error("the 'preload' value could not be read");
  }
  const scalar = end[0].trim();
  const stop = valueStart + end[0].length;
  return `${source.slice(0, valueAt)}[${scalar}, "${entry}"]${source.slice(stop)}`;
}

/** Inserts a `preload` key for a section that does not declare one. */
function insertAssignment(source: string, entry: string, section: PreloadSection): string {
  const line = `preload = ["${entry}"]`;

  if (section === '') {
    const firstHeader = /^\s*\[/m.exec(source);
    if (!firstHeader) {
      const separator = source === '' || source.endsWith('\n') ? '' : '\n';
      return `${source}${separator}${line}\n`;
    }
    // A blank line keeps the new key from reading as part of the section.
    return `${source.slice(0, firstHeader.index)}${line}\n\n${source.slice(firstHeader.index)}`;
  }

  const header = new RegExp(`^\\s*\\[${section}\\]\\s*$`, 'm').exec(source);
  if (header) {
    const insertAt = header.index + header[0].length;
    return `${source.slice(0, insertAt)}\n${line}${source.slice(insertAt)}`;
  }

  const separator = source === '' || source.endsWith('\n') ? '' : '\n';
  const blank = source.trim() === '' ? '' : '\n';
  return `${source}${separator}${blank}[${section}]\n${line}\n`;
}

/**
 * Adds `entry` to a section's `preload` list, leaving the rest of the file
 * alone. Returns `changed: false` when it is already listed.
 */
export function addPreload(source: string, entry: string, section: PreloadSection): PreloadEdit {
  const declared = declaredPreload(source, section);

  if (declared?.some((existing) => samePath(existing, entry))) {
    return { source, changed: false };
  }
  if (declared === undefined) {
    return { source: insertAssignment(source, entry, section), changed: true };
  }

  const assignment = findAssignment(source, section);
  if (!assignment) {
    // The parser sees a value the scanner cannot place, so editing would risk
    // writing a second one. Better to say so than to corrupt the file.
    throw new Error(
      `'${section === '' ? 'preload' : `${section}.preload`}' is set in bunfig.toml but could not be located for editing; add "${entry}" to it by hand`
    );
  }
  return { source: extendAssignment(source, assignment.valueStart, entry), changed: true };
}
