import type { ApiIR } from "../ir/api.ts";
import { isHttpMethod, type HttpServiceMethodIR, type ServiceIR } from "../ir/service.ts";
import type { TypeIR } from "../ir/types.ts";
import type { Generator, GeneratorContext } from "./generator.ts";
import { methodNames, tsClientGenerator, type TsClientOptions } from "./tsClient.ts";

export interface CliGeneratorOptions extends TsClientOptions {
    /** The executable name of the CLI. Defaults to the service name or "cli". */
    binName?: string;
}

function generateCliCode(
    service: ServiceIR,
    apiIR: ApiIR | undefined,
    context: GeneratorContext<CliGeneratorOptions>,
): string {
    const binName = context.options.binName ?? (service.name ? service.name.toLowerCase() : "cli");
    const names = methodNames(service);
    const methods = service.methods.filter(isHttpMethod) as HttpServiceMethodIR[];

    const securitySchemes = apiIR?.components?.securitySchemes ?? new Map();
    const availableAuthSchemes = Array.from(securitySchemes.entries()).map(([name, s]) => ({
        name,
        type: s.type,
        scheme: s.scheme,
        in: s.in,
        keyName: s.name,
        tokenUrl: s.flows?.clientCredentials?.tokenUrl ?? s.flows?.authorizationCode?.tokenUrl,
    }));

    return `#!/usr/bin/env bun
// Generated CLI for ${service.name ?? binName}
import { parseArgs } from "node:util";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { join } from "node:path";
import { homedir } from "node:os";
import * as client from "./api.ts";

const BIN_NAME = ${JSON.stringify(binName)};
const AUTH_SCHEMES = ${JSON.stringify(availableAuthSchemes, null, 2)};

// ---------------------------------------------------------------------------
// Configuration & Secrets via Bun.secrets with file-based fallback
// ---------------------------------------------------------------------------

function getEnv(): string {
    const envFlagIdx = process.argv.indexOf("--env");
    if (envFlagIdx !== -1 && process.argv[envFlagIdx + 1]) {
        return process.argv[envFlagIdx + 1]!;
    }
    const envEq = process.argv.find((a) => a.startsWith("--env="));
    if (envEq) {
        return envEq.slice(6);
    }
    return "default";
}

function configFilePath(): string {
    return join(homedir(), \`.\${BIN_NAME}.config.json\`);
}

async function readFallbackFile(): Promise<Record<string, Record<string, string>>> {
    try {
        const file = Bun.file(configFilePath());
        if (await file.exists()) {
            return JSON.parse(await file.text());
        }
    } catch {}
    return {};
}

async function writeFallbackFile(data: Record<string, Record<string, string>>): Promise<void> {
    try {
        await Bun.write(configFilePath(), JSON.stringify(data, null, 2));
    } catch {}
}

async function getConfigKey(key: string, env: string): Promise<string | null> {
    // 1. Try Bun.secrets
    try {
        const s = (globalThis as any).Bun?.secrets;
        if (s && typeof s.get === "function") {
            const val = await s.get({ service: \`\${BIN_NAME}:\${env}\`, name: key });
            if (val !== null && val !== undefined) return val;
        }
    } catch {}

    // 2. Try file fallback
    const fileData = await readFallbackFile();
    if (fileData[env]?.[key] !== undefined) {
        return fileData[env][key]!;
    }

    // 3. Fall back to process.env
    const envVar = \`\${BIN_NAME.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_\${key.toUpperCase()}\`;
    return process.env[envVar] ?? null;
}

async function setConfigKey(key: string, value: string, env: string): Promise<void> {
    let savedInSecrets = false;
    try {
        const s = (globalThis as any).Bun?.secrets;
        if (s && typeof s.set === "function") {
            await s.set({ service: \`\${BIN_NAME}:\${env}\`, name: key, value });
            savedInSecrets = true;
        }
    } catch {}

    // Always mirror to config file as reliable storage across environments / headless test runners
    const fileData = await readFallbackFile();
    fileData[env] ??= {};
    fileData[env][key] = value;
    await writeFallbackFile(fileData);
}

async function loadClientConfig(env: string): Promise<void> {
    const baseUrl = await getConfigKey("baseUrl", env);
    const bearer = await getConfigKey("bearer", env);
    const apiKey = await getConfigKey("apiKey", env);

    if (baseUrl) {
        client.configure({ baseUrl });
    }
    if (bearer) {
        client.setBearerToken(bearer);
    }
    if (apiKey) {
        client.setApiKey(apiKey);
    }
}

// ---------------------------------------------------------------------------
// Interactive Auth Guider
// ---------------------------------------------------------------------------

async function handleAuth(env: string) {
    console.log(\`\\n--- Authenticate \${BIN_NAME} (environment: \${env}) ---\\n\`);
    const rl = readline.createInterface({ input, output });

    try {
        console.log("Select an authentication mechanism:");
        console.log("  1) Bearer Token / JWT");
        console.log("  2) API Key");
        console.log("  3) OAuth2 Client Credentials");

        const choice = (await rl.question("\\nChoice [1-3]: ")).trim();

        if (choice === "1") {
            const token = (await rl.question("Enter Bearer Token: ")).trim();
            if (token) {
                await setConfigKey("bearer", token, env);
                console.log(\`\\x1b[32m✔ Bearer token saved for env '\${env}'.\\x1b[0m\`);
            }
        } else if (choice === "2") {
            const apiKey = (await rl.question("Enter API Key: ")).trim();
            if (apiKey) {
                await setConfigKey("apiKey", apiKey, env);
                console.log(\`\\x1b[32m✔ API Key saved for env '\${env}'.\\x1b[0m\`);
            }
        } else if (choice === "3") {
            const defaultTokenUrl = AUTH_SCHEMES.find((s) => s.tokenUrl)?.tokenUrl ?? "";
            const tokenUrlPrompt = defaultTokenUrl ? \`Token URL [\${defaultTokenUrl}]: \` : "Token URL: ";
            const tokenUrlInput = (await rl.question(tokenUrlPrompt)).trim();
            const tokenUrl = tokenUrlInput || defaultTokenUrl;

            const clientId = (await rl.question("Client ID: ")).trim();
            const clientSecret = (await rl.question("Client Secret: ")).trim();
            const scopes = (await rl.question("Scopes (comma/space separated, optional): ")).trim();

            if (tokenUrl && clientId && clientSecret) {
                console.log("Requesting OAuth2 access token...");
                const provider = client.createOAuth2ClientCredentialsProvider({
                    tokenUrl,
                    clientId,
                    clientSecret,
                    scopes: scopes ? scopes.split(/[,\\s]+/) : undefined,
                });
                try {
                    const token = await provider();
                    await setConfigKey("bearer", token, env);
                    console.log(\`\\x1b[32m✔ OAuth2 token fetched and saved for env '\${env}'.\\x1b[0m\`);
                } catch (err: any) {
                    console.error(\`\\x1b[31m✖ Failed to fetch token: \${err.message}\\x1b[0m\`);
                }
            }
        } else {
            console.log("Invalid choice.");
        }
    } finally {
        rl.close();
    }
}

// ---------------------------------------------------------------------------
// Config Handler
// ---------------------------------------------------------------------------

async function handleConfig(args: string[], env: string) {
    if (args.length === 0) {
        console.log(\`Configuration for env '\${env}':\`);
        const baseUrl = await getConfigKey("baseUrl", env);
        const bearer = await getConfigKey("bearer", env);
        const apiKey = await getConfigKey("apiKey", env);
        console.log(\`  baseUrl : \${baseUrl ?? "(not set)"}\`);
        console.log(\`  bearer  : \${bearer ? "********" : "(not set)"}\`);
        console.log(\`  apiKey  : \${apiKey ? "********" : "(not set)"}\`);
        return;
    }

    const [key, ...rest] = args;
    const value = rest.join(" ");
    if (!key) return;

    if (!value) {
        const current = await getConfigKey(key, env);
        console.log(\`\${key}: \${current ?? "(not set)"}\`);
        return;
    }

    await setConfigKey(key, value, env);
    console.log(\`\\x1b[32m✔ Set \${key} for env '\${env}'\\x1b[0m\`);
}

// ---------------------------------------------------------------------------
// CLI Dispatcher
// ---------------------------------------------------------------------------

async function main() {
    const rawArgs = process.argv.slice(2);
    const env = getEnv();

    // Filter out --env flags
    const cleanArgs: string[] = [];
    for (let i = 0; i < rawArgs.length; i++) {
        if (rawArgs[i] === "--env") {
            i++; // skip value
            continue;
        }
        if (rawArgs[i]?.startsWith("--env=")) {
            continue;
        }
        cleanArgs.push(rawArgs[i]!);
    }

    const command = cleanArgs[0];
    const subArgs = cleanArgs.slice(1);

    if (!command || command === "--help" || command === "-h" || command === "help") {
        printHelp();
        return;
    }

    if (command === "config") {
        await handleConfig(subArgs, env);
        return;
    }

    if (command === "auth") {
        await handleAuth(env);
        return;
    }

    await loadClientConfig(env);

    switch (command) {
${methods
    .map((m) => {
        const opName = names.get(m)!;
        return `        case ${JSON.stringify(opName)}: {
            await execute_${opName}(subArgs);
            break;
        }`;
    })
    .join("\n")}
        default: {
            console.error(\`Unknown command: \${command}\\nRun '\${BIN_NAME} --help' for available commands.\`);
            process.exit(1);
        }
    }
}

function printHelp() {
    console.log(\`Usage: \${BIN_NAME} <command> [options] [--env <name>]\\n\`);
    console.log("Configuration Commands:");
    console.log("  config [key] [value]   Get or set persistent configuration (baseUrl, bearer, apiKey)");
    console.log("  auth                   Guided interactive authentication helper\\n");
    console.log("API Commands:");
${methods
    .map((m) => {
        const opName = names.get(m)!;
        const summary = m.summary ?? m.description ?? "";
        return `    console.log("  ${opName.padEnd(22)} ${summary.slice(0, 50).replace(/"/g, '\\"')}");`;
    })
    .join("\n")}
}

${methods
    .map((m) => {
        const opName = names.get(m)!;
        const pathParams = (m.request.parameters ?? []).filter((p) => p.in === "path");
        const queryParams = (m.request.parameters ?? []).filter((p) => p.in === "query");
        const hasBody = Boolean(m.request.body);

        return `async function execute_${opName}(args: string[]) {
    const { values, positionals } = parseArgs({
        args,
        options: {
${[
    ...pathParams.map((p) => `            ${JSON.stringify(p.name)}: { type: "string" },`),
    ...queryParams.map((p) => `            ${JSON.stringify(p.name)}: { type: "string" },`),
    ...(hasBody ? ['            body: { type: "string" },', '            file: { type: "string" },'] : []),
].join("\n")}
        },
        allowPositionals: true,
        strict: false,
    });

    const path: Record<string, any> = {};
${pathParams.map((p, idx) => `    path[${JSON.stringify(p.name)}] = values[${JSON.stringify(p.name)}] ?? positionals[${idx}];`).join("\n")}

    const query: Record<string, any> = {};
${queryParams.map((p) => `    if (values[${JSON.stringify(p.name)}]) query[${JSON.stringify(p.name)}] = values[${JSON.stringify(p.name)}];`).join("\n")}

    let body: any;
${
    hasBody
        ? `    if (values.file) {
        body = JSON.parse(await Bun.file(values.file as string).text());
    } else if (values.body) {
        body = JSON.parse(values.body as string);
    } else if (positionals[${pathParams.length}]) {
        try {
            body = JSON.parse(positionals[${pathParams.length}]!);
        } catch {
            body = positionals[${pathParams.length}];
        }
    }`
        : ""
}

    try {
        const res = await (client as any).${opName}(
            ${[pathParams.length > 0 ? "path" : "", hasBody ? "body" : "", queryParams.length > 0 ? "query" : ""]
                .filter(Boolean)
                .join(", ")}
        );

        if (res && typeof res === "object" && Symbol.asyncIterator in res) {
            for await (const chunk of res) {
                console.log(typeof chunk === "string" ? chunk : JSON.stringify(chunk, null, 2));
            }
        } else if (res !== undefined) {
            console.log(typeof res === "string" ? res : JSON.stringify(res, null, 2));
        }
    } catch (err: any) {
        console.error(err.message ?? err);
        process.exit(1);
    }
}`;
    })
    .join("\n\n")}

if (import.meta.main) {
    main().catch((err) => {
        console.error(err);
        process.exit(1);
    });
}
`;
}

export const cliGenerator: Generator<CliGeneratorOptions> = {
    name: "cli",

    api(ir: ApiIR, context) {
        const baseFiles = tsClientGenerator.api!(ir, context);
        const cliCode = generateCliCode(ir.service, ir, context);
        return {
            ...baseFiles,
            "cli.ts": cliCode,
        };
    },

    service(ir: ServiceIR, context) {
        const baseFiles = tsClientGenerator.service!(ir, context);
        const cliCode = generateCliCode(ir, undefined, context);
        return {
            ...baseFiles,
            "cli.ts": cliCode,
        };
    },

    type(ir: TypeIR, context) {
        return tsClientGenerator.type ? tsClientGenerator.type(ir, context) : {};
    },
};

export default cliGenerator;
