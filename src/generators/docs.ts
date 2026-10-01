import type { ApiIR } from "../ir/api.ts";
import { isHttpMethod, type HttpServiceMethodIR, type ServiceIR } from "../ir/service.ts";
import type { TypeIR } from "../ir/types.ts";
import type { Generator, GeneratorContext } from "./generator.ts";
import { methodNames } from "./tsClient.ts";
import { tsDeclarations, typeIdentifiers } from "./tsTypes.ts";

export interface DocsGeneratorOptions {
    /** Document title override */
    title?: string;
    /** Theme for shiki code blocks (default: "github-dark") */
    theme?: string;
}

/**
 * Loads Shiki dynamically as a peer dependency.
 * Throws a clear instructional error if missing.
 */
async function loadShiki(): Promise<typeof import("shiki")> {
    try {
        return await import("shiki");
    } catch {
        throw new Error(
            "[wiz] Documentation generator requires 'shiki' for syntax highlighting.\n" +
                "Please install it as a dependency or peer dependency:\n\n" +
                "  bun add -d shiki\n" +
                "  # or: npm install -D shiki / pnpm add -D shiki\n",
        );
    }
}

function renderMarkdown(md: string | undefined): string {
    if (!md) {
        return "";
    }
    const bunMd = (globalThis as any).Bun?.markdown;
    if (bunMd && typeof bunMd.html === "function") {
        return bunMd.html(md);
    }
    // Fallback if not running in Bun with markdown support
    return `<p>${escapeHtml(md).replace(/\n\n/g, "</p><p>").replace(/\n/g, "<br/>")}</p>`;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function sampleJsonFromType(ir: TypeIR, visited = new Set<string>()): unknown {
    if (ir.name) {
        if (visited.has(ir.name)) {
            return { $ref: ir.name };
        }
        visited.add(ir.name);
    }

    switch (ir.kind) {
        case "primitive":
            switch (ir.type) {
                case "string":
                    return "string";
                case "number":
                    return 0;
                case "boolean":
                    return true;
                case "bigint":
                    return 0;
                case "date":
                    return new Date().toISOString();
                case "bytes":
                    return "ZXhhbXBsZQ==";
                case "null":
                    return null;
                default:
                    return null;
            }
        case "literal":
            return ir.value;
        case "array":
            return [sampleJsonFromType(ir.element, new Set(visited))];
        case "tuple":
            return ir.elements.map((el) => sampleJsonFromType(el.type, new Set(visited)));
        case "object": {
            const out: Record<string, unknown> = {};
            for (const prop of ir.properties) {
                out[prop.name] = sampleJsonFromType(prop.type, new Set(visited));
            }
            return out;
        }
        case "union":
            return ir.types[0] ? sampleJsonFromType(ir.types[0], new Set(visited)) : {};
        case "intersection": {
            let merged: Record<string, unknown> = {};
            for (const t of ir.types) {
                const s = sampleJsonFromType(t, new Set(visited));
                if (typeof s === "object" && s !== null) {
                    merged = { ...merged, ...(s as Record<string, unknown>) };
                }
            }
            return merged;
        }
        case "enum":
            return ir.members[0]?.value ?? "";
        case "record":
            return { key: sampleJsonFromType(ir.valueType, new Set(visited)) };
        case "ref":
            return ir.name ? { $ref: ir.name } : {};
        default:
            return {};
    }
}

export async function generateDocsHtml(
    apiIR: ApiIR | undefined,
    service: ServiceIR,
    types: Map<string, TypeIR> | undefined,
    context: GeneratorContext<DocsGeneratorOptions>,
): Promise<string> {
    const shiki = await loadShiki();
    const theme = context.options.theme ?? "github-dark";

    const title = context.options.title ?? service.name ?? apiIR?.service?.name ?? "API Documentation";
    const description = service.description ?? apiIR?.service?.description ?? "";
    const version = service.version ?? apiIR?.service?.version ?? "1.0.0";

    const names = methodNames(service);
    const methods = service.methods.filter(isHttpMethod) as HttpServiceMethodIR[];

    // Build categories / tags
    const taggedMethods = new Map<string, HttpServiceMethodIR[]>();
    for (const m of methods) {
        const tag = "General";
        if (!taggedMethods.has(tag)) {
            taggedMethods.set(tag, []);
        }
        taggedMethods.get(tag)!.push(m);
    }

    const allTypes = types ?? apiIR?.types ?? new Map();
    const identifiers = typeIdentifiers(allTypes.keys());
    const tsTypesCode = tsDeclarations(allTypes.entries(), identifiers);

    // Render Type Definitions Code Block
    const typesHtml = tsTypesCode
        ? await shiki.codeToHtml(tsTypesCode, { lang: "typescript", theme })
        : "<p>No explicit schema types declared.</p>";

    // Render Operation Sections
    const operationSections: string[] = [];
    const tocItems: string[] = [];

    for (const [tag, tagMethods] of taggedMethods) {
        tocItems.push(`<div class="toc-tag">${escapeHtml(tag)}</div>`);
        for (const m of tagMethods) {
            const opName = names.get(m)!;
            const httpMethod = m.address.method.toUpperCase();
            const path = m.address.path;
            const opId = `op-${opName}`;
            const methodBadgeClass = `badge-${httpMethod.toLowerCase()}`;

            tocItems.push(
                `<a href="#${opId}" class="toc-link">` +
                    `<span class="badge ${methodBadgeClass}">${httpMethod}</span>` +
                    `<span class="toc-op-name">${escapeHtml(opName)}</span>` +
                    `</a>`,
            );

            const opDocHtml = renderMarkdown(m.description || m.summary);

            // Request body sample
            let reqBodyCodeHtml = "";
            const bodyIR = m.request.body?.[0]?.content;
            if (bodyIR) {
                const sampleReq = sampleJsonFromType(bodyIR);
                const reqJson = JSON.stringify(sampleReq, null, 2);
                reqBodyCodeHtml = await shiki.codeToHtml(reqJson, { lang: "json", theme });
            }

            // Response sample
            let resBodyCodeHtml = "";
            const resp2xx = m.responses.find((r) => typeof r.status === "number" && r.status >= 200 && r.status < 300);
            const resBodyIR = resp2xx?.body?.[0]?.content;
            if (resBodyIR) {
                const sampleRes = sampleJsonFromType(resBodyIR);
                const resJson = JSON.stringify(sampleRes, null, 2);
                resBodyCodeHtml = await shiki.codeToHtml(resJson, { lang: "json", theme });
            }

            // Parameters Table
            const params = m.request.parameters ?? [];
            let paramsTableHtml = "";
            if (params.length > 0) {
                paramsTableHtml = `
          <div class="params-section">
            <h4>Parameters</h4>
            <table class="params-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>In</th>
                  <th>Type</th>
                  <th>Required</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                ${params
                    .map(
                        (p) => `
                  <tr>
                    <td><code>${escapeHtml(p.name)}</code></td>
                    <td><span class="param-in">${p.in}</span></td>
                    <td><code>${p.type ? escapeHtml(p.type.kind) : "string"}</code></td>
                    <td>${p.required ? '<span class="required">required</span>' : "optional"}</td>
                    <td>${escapeHtml(p.description ?? "")}</td>
                  </tr>`,
                    )
                    .join("")}
              </tbody>
            </table>
          </div>`;
            }

            operationSections.push(`
        <section id="${opId}" class="operation-card">
          <div class="operation-header">
            <span class="badge ${methodBadgeClass} badge-large">${httpMethod}</span>
            <code class="operation-path">${escapeHtml(path)}</code>
          </div>
          <h3 class="operation-title">${escapeHtml(m.summary ?? opName)}</h3>
          
          <div class="operation-grid">
            <div class="operation-main">
              <div class="operation-desc">${opDocHtml}</div>
              ${paramsTableHtml}
            </div>
            
            <div class="operation-sidebar">
              ${
                  reqBodyCodeHtml
                      ? `
                <div class="code-box">
                  <div class="code-box-header">Request Example (JSON)</div>
                  ${reqBodyCodeHtml}
                </div>`
                      : ""
              }
              
              ${
                  resBodyCodeHtml
                      ? `
                <div class="code-box">
                  <div class="code-box-header">Response Example (${resp2xx?.status ?? 200})</div>
                  ${resBodyCodeHtml}
                </div>`
                      : ""
              }
            </div>
          </div>
        </section>
      `);
        }
    }

    // Security Schemes info
    const secSchemes = apiIR?.components?.securitySchemes;
    let authInfoHtml = "";
    if (secSchemes && secSchemes.size > 0) {
        authInfoHtml = `
      <section id="authentication" class="doc-section">
        <h2>Authentication</h2>
        <p>This API supports the following authentication mechanisms:</p>
        <ul>
          ${Array.from(secSchemes.entries())
              .map(
                  ([name, s]) =>
                      `<li><strong>${escapeHtml(name)}</strong> (${s.type}${s.scheme ? ` / ${s.scheme}` : ""})</li>`,
              )
              .join("")}
        </ul>
      </section>`;
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --panel-bg: #161b22;
      --card-bg: #1f242c;
      --border: #30363d;
      --text: #e6edf3;
      --text-muted: #8b949e;
      --accent: #58a6ff;
      --badge-get: #238636;
      --badge-post: #1f6feb;
      --badge-put: #d29922;
      --badge-patch: #9e6a03;
      --badge-delete: #da3633;
      --badge-head: #8957e5;
      --badge-options: #6e7681;
      --code-bg: #090d13;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.6;
      display: flex;
      min-height: 100vh;
    }

    /* 3-Column Layout: Sticky Left TOC, Main Center, Right Examples */
    #sidebar-toc {
      width: 280px;
      flex-shrink: 0;
      position: sticky;
      top: 0;
      height: 100vh;
      overflow-y: auto;
      background: var(--panel-bg);
      border-right: 1px solid var(--border);
      padding: 24px 16px;
    }

    .toc-title { font-size: 1.1rem; font-weight: 700; margin-bottom: 8px; color: var(--text); }
    .toc-version { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 20px; }
    .toc-tag { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; color: var(--text-muted); margin: 16px 0 8px; letter-spacing: 0.5px; }
    .toc-link {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 6px;
      color: var(--text);
      text-decoration: none;
      font-size: 0.85rem;
      transition: background 0.15s ease;
      margin-bottom: 4px;
    }
    .toc-link:hover { background: rgba(88, 166, 255, 0.1); color: var(--accent); }
    .toc-op-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    #main-content {
      flex: 1;
      min-width: 0;
      padding: 40px;
      max-width: 1400px;
    }

    .api-header { margin-bottom: 40px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
    .api-header h1 { font-size: 2.5rem; margin-bottom: 12px; font-weight: 800; letter-spacing: -0.5px; }
    .api-desc { font-size: 1.1rem; color: var(--text-muted); max-width: 800px; }

    .doc-section { margin-bottom: 48px; }
    .doc-section h2 { font-size: 1.5rem; margin-bottom: 16px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }

    .operation-card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      margin-bottom: 36px;
      padding: 24px;
      scroll-margin-top: 24px;
    }

    .operation-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
    .operation-path { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 1rem; color: var(--text); }
    .operation-title { font-size: 1.25rem; font-weight: 600; margin-bottom: 16px; }

    .operation-grid {
      display: grid;
      grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
      gap: 24px;
      align-items: start;
    }

    @media (max-width: 1024px) {
      .operation-grid { grid-template-columns: 1fr; }
      body { flex-direction: column; }
      #sidebar-toc { width: 100%; height: auto; position: relative; }
    }

    .operation-desc { color: var(--text-muted); margin-bottom: 20px; font-size: 0.95rem; }

    /* Badges */
    .badge {
      font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      color: #fff;
      text-transform: uppercase;
      flex-shrink: 0;
    }
    .badge-large { font-size: 0.85rem; padding: 4px 8px; }
    .badge-get { background: var(--badge-get); }
    .badge-post { background: var(--badge-post); }
    .badge-put { background: var(--badge-put); }
    .badge-patch { background: var(--badge-patch); }
    .badge-delete { background: var(--badge-delete); }
    .badge-head { background: var(--badge-head); }
    .badge-options { background: var(--badge-options); }

    /* Parameters Table */
    .params-section { margin-top: 16px; }
    .params-section h4 { font-size: 0.9rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 8px; }
    .params-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
    .params-table th, .params-table td { padding: 8px 12px; border: 1px solid var(--border); text-align: left; }
    .params-table th { background: var(--panel-bg); color: var(--text-muted); font-weight: 600; }
    .param-in { font-size: 0.75rem; background: var(--border); padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
    .required { color: #f85149; font-weight: 600; }

    /* Right column Code Boxes */
    .code-box {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      margin-bottom: 16px;
      overflow: hidden;
    }
    .code-box-header {
      background: rgba(255, 255, 255, 0.05);
      padding: 8px 12px;
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .code-box pre {
      margin: 0 !important;
      padding: 16px !important;
      font-size: 0.85rem !important;
      overflow-x: auto;
    }

    .types-container {
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
    }
    .types-container pre {
      margin: 0 !important;
      padding: 20px !important;
      font-size: 0.85rem !important;
      overflow-x: auto;
    }
  </style>
</head>
<body>

  <!-- Sticky Left Table of Contents -->
  <nav id="sidebar-toc">
    <div class="toc-title">${escapeHtml(title)}</div>
    <div class="toc-version">Version ${escapeHtml(version)}</div>
    <div class="toc-tag">Navigation</div>
    <a href="#overview" class="toc-link">Overview</a>
    ${secSchemes && secSchemes.size > 0 ? '<a href="#authentication" class="toc-link">Authentication</a>' : ""}
    <a href="#schemas" class="toc-link">Model Schemas</a>
    ${tocItems.join("\n")}
  </nav>

  <!-- Main Center + Right Documentation Content -->
  <main id="main-content">
    <header id="overview" class="api-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="api-desc">${renderMarkdown(description)}</div>
    </header>

    ${authInfoHtml}

    <section id="operations" class="doc-section">
      <h2>API Operations</h2>
      ${operationSections.join("\n")}
    </section>

    <section id="schemas" class="doc-section">
      <h2>Model Schemas</h2>
      <p style="color: var(--text-muted); margin-bottom: 16px;">TypeScript definitions for all data types exchanged by this API.</p>
      <div class="types-container">
        ${typesHtml}
      </div>
    </section>
  </main>

</body>
</html>`;
}

export const docsGenerator: Generator<DocsGeneratorOptions> = {
    name: "docs",

    async api(ir: ApiIR, context) {
        const html = await generateDocsHtml(ir, ir.service, ir.types, context);
        return {
            "index.html": html,
        };
    },

    async service(ir: ServiceIR, context) {
        const html = await generateDocsHtml(undefined, ir, undefined, context);
        return {
            "index.html": html,
        };
    },

    type(_ir: TypeIR, _context) {
        return {};
    },
};

export default docsGenerator;
