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
const DEFAULT_PROFILE = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? "/tmp",
  ".octopal",
  "browser-profile",
);
const PROFILE_DIR = process.env[PROFILE_DIR_ENV] ?? DEFAULT_PROFILE;

/** Run a playwright-cli command and return stdout */
function runPlaywright(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const cli = getPlaywrightCli();
    log.debug(`exec: ${cli} ${args.join(" ")}`);
    execFile(cli, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 5 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.trim() || stdout?.trim() || err.message;
        reject(new Error(msg));
      } else {
        resolve(stdout);
      }
    });
  });
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
        "Open a URL in the browser and return a snapshot of the page content. " +
        "Use this instead of web_fetch for most websites — it handles JavaScript-rendered pages, " +
        "bot-blocked sites, and pages that require login (persistent cookies are maintained). " +
        "The browser stays open after this call for follow-up interactions via browser_action. " +
        "Only use web_fetch for simple API/JSON endpoints where a full browser is unnecessary.",
      parameters: z.object({
        url: z.string().describe("The URL to navigate to"),
      }),
      handler: async ({ url }: { url: string }) => {
        const done = log.timed("browse_url");
        try {
          await ensureBrowserOpen(url);
          const snapshot = await takeSnapshot();
          done();
          return snapshot || "Page loaded but snapshot returned empty content.";
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
        "Element refs (like e15) come from snapshots — take a new snapshot after navigation or interaction.",
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
          return result || `${command} completed successfully.`;
        } catch (err: any) {
          done();
          return `Browser error: ${err.message}`;
        }
      },
    }),
  ];
}
