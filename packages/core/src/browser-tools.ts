import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { execFile } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./log.js";

const log = createLogger("browser");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the playwright-cli binary path */
function getPlaywrightCli(): string {
  return path.resolve(__dirname, "../../../node_modules/.bin/playwright-cli");
}

const SESSION_NAME = "octopal";
const PROFILE_DIR_ENV = "OCTOPAL_BROWSER_PROFILE";
const HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? "/tmp";
const DEFAULT_PROFILE = path.join(HOME_DIR, ".octopal", "browser-profile");
const PROFILE_DIR = process.env[PROFILE_DIR_ENV] ?? DEFAULT_PROFILE;

/** Fixed CWD for playwright-cli so snapshot files land in a predictable location */
const BROWSER_CWD = path.join(HOME_DIR, ".octopal");

/** Run a playwright-cli command and return stdout */
function runPlaywright(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const cli = getPlaywrightCli();
    log.debug(`exec: ${cli} ${args.join(" ")}`);
    execFile(cli, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 5, cwd: BROWSER_CWD }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Extract page metadata and resolve snapshot paths from playwright-cli stdout */
function parsePlaywrightOutput(stdout: string): { url?: string; title?: string; snapshotPath?: string; raw: string } {
  const urlMatch = stdout.match(/- Page URL:\s*(.+)/);
  const titleMatch = stdout.match(/- Page Title:\s*(.+)/);
  const snapshotMatch = stdout.match(/\[Snapshot\]\(([^)]+\.yml)\)/);

  return {
    url: urlMatch?.[1]?.trim(),
    title: titleMatch?.[1]?.trim(),
    snapshotPath: snapshotMatch ? path.resolve(BROWSER_CWD, snapshotMatch[1]) : undefined,
    raw: stdout,
  };
}

/** Format a structured result for browse_url / snapshot actions */
function formatBrowseResult(parsed: ReturnType<typeof parsePlaywrightOutput>): string {
  const lines: string[] = [];
  if (parsed.url) lines.push(`Page: ${parsed.url}`);
  if (parsed.title) lines.push(`Title: ${parsed.title}`);
  if (parsed.snapshotPath) {
    lines.push("");
    lines.push(`Snapshot: ${parsed.snapshotPath}`);
    lines.push("Read this file to see page structure with element refs (e.g. e15) for click/fill actions.");
    lines.push('For plain text content, use browser_action(command: "eval", text: "document.body.innerText").');
  }
  return lines.length > 0 ? lines.join("\n") : parsed.raw;
}

/** Check if a browser session is already running */
async function isSessionOpen(): Promise<boolean> {
  try {
    const out = await runPlaywright(["list"], 5_000);
    return out.includes(SESSION_NAME);
  } catch {
    return false;
  }
}

/** Ensure the browser is open. Opens with persistent profile if not already running. */
async function ensureBrowserOpen(url?: string): Promise<string> {
  if (await isSessionOpen()) {
    if (url) {
      return runPlaywright([`-s=${SESSION_NAME}`, "goto", url]);
    }
    return "Browser session already open.";
  }

  // Open new session with persistent profile
  const args = [
    "open",
    ...(url ? [url] : []),
    "--persistent",
    `--profile=${PROFILE_DIR}`,
    `-s=${SESSION_NAME}`,
    "--browser=chromium",
  ];
  return runPlaywright(args, 30_000);
}

/** Take a snapshot of the current page */
async function takeSnapshot(): Promise<string> {
  return runPlaywright([`-s=${SESSION_NAME}`, "snapshot"]);
}

/** Build the browser tools */
export function buildBrowserTools() {
  return [
    defineTool("browse_url", {
      description:
        "Open a URL in the browser and return page metadata plus a snapshot file path. " +
        "Use this instead of web_fetch for most websites — it handles JavaScript-rendered pages, " +
        "bot-blocked sites, and pages that require login (persistent cookies are maintained). " +
        "The browser stays open after this call for follow-up interactions via browser_action. " +
        "Only use web_fetch for simple API/JSON endpoints where a full browser is unnecessary. " +
        "The snapshot file contains the page structure with element refs needed for click/fill actions.",
      parameters: z.object({
        url: z.string().describe("The URL to navigate to"),
      }),
      handler: async ({ url }: { url: string }) => {
        const done = log.timed("browse_url");
        try {
          await ensureBrowserOpen(url);
          const snapshot = await takeSnapshot();
          done();
          const parsed = parsePlaywrightOutput(snapshot);
          return formatBrowseResult(parsed) || "Page loaded but snapshot returned empty content.";
        } catch (err: any) {
          done();
          return `Browser error: ${err.message}`;
        }
      },
    }),

    defineTool("browser_action", {
      description:
        "Interact with the currently open browser page. The browser must already be open " +
        "(via browse_url). Use snapshot to see the current page state and get element refs. " +
        "Element refs (like e15) come from snapshot files — take a new snapshot after navigation or interaction.",
      parameters: z.object({
        command: z.enum([
          "snapshot",
          "click",
          "fill",
          "type",
          "press",
          "select",
          "hover",
          "check",
          "uncheck",
          "goto",
          "go_back",
          "go_forward",
          "reload",
          "screenshot",
          "eval",
        ]).describe("The browser action to perform"),
        ref: z.string().optional().describe("Element reference from a snapshot (e.g. 'e15'). Required for click, fill, select, hover, check, uncheck, screenshot (element)."),
        text: z.string().optional().describe("Text input for fill, type, press (key name), eval (expression), or goto (URL)."),
      }),
      handler: async ({ command, ref, text }: { command: string; ref?: string; text?: string }) => {
        const done = log.timed("browser_action");
        try {
          // Map underscored commands to hyphenated playwright-cli commands
          const cliCommand = command.replace(/_/g, "-");
          const args: string[] = [`-s=${SESSION_NAME}`, cliCommand];

          switch (command) {
            case "click":
            case "hover":
            case "check":
            case "uncheck":
              if (!ref) return "Error: 'ref' is required for this command.";
              args.push(ref);
              break;
            case "fill":
              if (!ref || text === undefined) return "Error: 'ref' and 'text' are required for fill.";
              args.push(ref, text);
              break;
            case "type":
              if (text === undefined) return "Error: 'text' is required for type.";
              args.push(text);
              break;
            case "press":
              if (!text) return "Error: 'text' (key name) is required for press.";
              args.push(text);
              break;
            case "select":
              if (!ref || !text) return "Error: 'ref' and 'text' (value) are required for select.";
              args.push(ref, text);
              break;
            case "goto":
              if (!text) return "Error: 'text' (URL) is required for goto.";
              args.push(text);
              break;
            case "eval":
              if (!text) return "Error: 'text' (expression) is required for eval.";
              args.push(text);
              break;
            case "screenshot":
              if (ref) args.push(ref);
              break;
            // snapshot, go_back, go_forward, reload — no extra args
          }

          const result = await runPlaywright(args);
          done();

          // For snapshot command, parse and format like browse_url
          if (command === "snapshot") {
            const parsed = parsePlaywrightOutput(result);
            return formatBrowseResult(parsed) || "Snapshot completed.";
          }

          return result || `${command} completed successfully.`;
        } catch (err: any) {
          done();
          return `Browser error: ${err.message}`;
        }
      },
    }),
  ];
}
