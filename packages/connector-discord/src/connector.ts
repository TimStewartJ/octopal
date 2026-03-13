import { Client, GatewayIntentBits, Partials, ChannelType, type Message } from "discord.js";
import type { SessionEvent } from "@github/copilot-sdk";
import { createLogger, type DiscordConfig, type QueuedAttachment, type Source } from "@octopal/core";
import { splitMessage } from "./messages.js";
import { DiscordActivityRenderer, type ActivityChannel } from "./activity.js";
import { writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

const log = createLogger("discord");

/** Minimal session interface — avoids circular dependency on @octopal/server */
export interface ConnectorSession {
  sendAndWait(message: { prompt: string }, timeoutMs: number): Promise<{ data?: { content?: string } } | undefined>;
}

/** SDK-compatible file attachment */
export interface FileAttachment {
  type: "file";
  path: string;
  displayName?: string;
}

export interface ConnectorSessionStore {
  getOrCreate(sessionId: string): Promise<ConnectorSession>;
  sendOrRecover(
    sessionId: string,
    prompt: string,
    options?: {
      attachments?: FileAttachment[];
      inactivityTimeoutMs?: number;
      onEvent?: (event: SessionEvent) => void;
      onSource?: (source: Source) => void;
    },
  ): Promise<{ response: { data?: { content?: string } } | undefined; recovered: boolean }>;
}

/** Generates a short thread title from a user message */
export interface ThreadTitleGenerator {
  generateTitle(messageText: string): Promise<string>;
}

export class DiscordConnector {
  private client: Client;
  private allowedSet: Set<string>;
  private channelSet: Set<string>;
  private guildSet: Set<string>;
  private mentionOnReply: boolean;

  constructor(
    private config: DiscordConfig,
    private sessionStore: ConnectorSessionStore,
    private titleGenerator?: ThreadTitleGenerator,
    private drainAttachments?: (sessionId: string) => QueuedAttachment[],
  ) {
    this.allowedSet = new Set(config.allowedUsers);
    this.channelSet = new Set(config.channels ?? []);
    this.guildSet = new Set(config.guilds ?? []);
    this.mentionOnReply = config.mentionOnReply ?? true;
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });
  }

  /** Expose the Discord client for tools */
  getClient(): Client {
    return this.client;
  }

  /** Get the set of configured channel IDs */
  getChannelIds(): Set<string> {
    return this.channelSet;
  }

  async start(): Promise<void> {
    this.client.on("ready", () => {
      log.info(`Logged in as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", (message) => {
      this.handleMessage(message).catch((err) => {
        log.error("Error handling message:", err);
      });
    });

    await this.client.login(this.config.botToken);
  }

  async stop(): Promise<void> {
    this.client.removeAllListeners();
    await this.client.destroy();
    log.info("Disconnected");
  }

  /** Send any queued attachments for this session */
  private async sendQueuedAttachments(
    channel: { send(options: any): Promise<any> },
    sessionId: string,
  ): Promise<void> {
    if (!this.drainAttachments) return;
    const attachments = this.drainAttachments(sessionId);
    for (const att of attachments) {
      try {
        await channel.send({
          content: att.caption ?? "",
          files: [{ attachment: att.path }],
        });
      } catch (err) {
        log.warn(`Failed to send attachment ${att.path}:`, err);
      }
    }
  }

  /** Download Discord message attachments to temp files, returning SDK-compatible attachment objects */
  private async downloadAttachments(message: Message): Promise<{ attachments: FileAttachment[]; tempPaths: string[] }> {
    const attachments: FileAttachment[] = [];
    const tempPaths: string[] = [];

    for (const [, att] of message.attachments) {
      if (att.size > 25 * 1024 * 1024) continue; // Skip files >25MB
      try {
        const resp = await fetch(att.url);
        if (!resp.ok) continue;
        const buffer = Buffer.from(await resp.arrayBuffer());
        const dir = join(tmpdir(), "octopal-attachments");
        await mkdir(dir, { recursive: true });
        const tempPath = join(dir, `${randomUUID()}-${att.name}`);
        await writeFile(tempPath, buffer);
        attachments.push({ type: "file", path: tempPath, displayName: att.name });
        tempPaths.push(tempPath);
      } catch (err) {
        log.warn(`Failed to download attachment ${att.name}:`, err);
      }
    }

    return { attachments, tempPaths };
  }

  /** Schedule temp file cleanup after a delay (files may still be referenced by the model) */
  private scheduleTempCleanup(paths: string[], delayMs = 5 * 60 * 1000): void {
    if (!paths.length) return;
    setTimeout(async () => {
      for (const p of paths) {
        try { await unlink(p); } catch { /* already deleted */ }
      }
    }, delayMs);
  }

  private async handleMessage(message: Message): Promise<void> {
    // Ignore bots
    if (message.author.bot) return;

    // Whitelist check
    if (!this.allowedSet.has(message.author.id)) return;

    const text = message.content.trim();
    const hasAttachments = message.attachments.size > 0;
    if (!text && !hasAttachments) return;

    // Download any attachments to temp files
    const { attachments, tempPaths } = hasAttachments
      ? await this.downloadAttachments(message)
      : { attachments: [], tempPaths: [] };

    // If only attachments with no text, use a descriptive prompt
    const prompt = text || `[User sent ${attachments.length} file(s): ${message.attachments.map((a) => a.name).join(", ")}]`;

    // Clean up temp files after 5 minutes (model may reference them during the turn)
    this.scheduleTempCleanup(tempPaths);

    const channelType = message.channel.type;

    // DM
    if (channelType === ChannelType.DM) {
      await this.handleDM(message, prompt, attachments);
      return;
    }

    // Thread in a configured channel or guild
    if (
      channelType === ChannelType.PublicThread ||
      channelType === ChannelType.PrivateThread
    ) {
      const parentId = message.channel.parentId;
      const inGuild = message.guild && this.guildSet.has(message.guild.id);
      if (inGuild || (parentId && this.channelSet.has(parentId))) {
        await this.handleThread(message, prompt, attachments);
      }
      return;
    }

    // Message in a configured channel or guild — auto-create thread
    const inGuild = message.guild && this.guildSet.has(message.guild.id);
    if (channelType === ChannelType.GuildText && (this.channelSet.has(message.channel.id) || inGuild)) {
      await this.handleChannelMessage(message, prompt, attachments);
      return;
    }
  }

  /** Handle a DM message */
  private async handleDM(message: Message, text: string, attachments: FileAttachment[] = []): Promise<void> {
    const sessionId = `discord-dm-${message.author.id}`;
    const channel = message.channel;
    if (!("send" in channel)) return;
    await this.replyInChannel(channel, sessionId, text, message.author.id, attachments);
  }

  /** Handle a message in an existing thread */
  private async handleThread(message: Message, text: string, attachments: FileAttachment[] = []): Promise<void> {
    const sessionId = `discord-th-${message.channel.id}`;
    const channel = message.channel;
    if (!("send" in channel)) return;
    await this.replyInChannel(channel, sessionId, text, message.author.id, attachments);
  }

  /** Handle a message in a configured channel — auto-create a thread */
  private async handleChannelMessage(message: Message, text: string, attachments: FileAttachment[] = []): Promise<void> {
    const channel = message.channel;

    // Show typing while generating title + waiting for agent
    const typingInterval = setInterval(() => {
      ("sendTyping" in channel) && (channel as any).sendTyping().catch(() => {});
    }, 8_000);
    if ("sendTyping" in channel) await (channel as any).sendTyping().catch(() => {});

    try {
      // Generate a thread title
      let threadName = text.slice(0, 50);
      if (this.titleGenerator) {
        try {
          threadName = await this.titleGenerator.generateTitle(text);
        } catch (err) {
          log.error("Failed to generate thread title, using fallback:", err);
        }
      }

      // Create thread from the message
      const thread = await message.startThread({
        name: threadName.slice(0, 100), // Discord limit
      });

      // Continue typing in the thread while the agent responds
      clearInterval(typingInterval);
      const threadTypingInterval = setInterval(() => {
        thread.sendTyping().catch(() => {});
      }, 8_000);
      await thread.sendTyping().catch(() => {});

      try {
        const sessionId = `discord-th-${thread.id}`;
        await this.replyInThread(thread, sessionId, text, message.author.id, attachments);
      } finally {
        clearInterval(threadTypingInterval);
      }
    } finally {
      clearInterval(typingInterval);
    }
  }

  /** Send a prompt to the agent and reply in a thread (no typing — caller manages it) */
  private async replyInThread(
    channel: { send(content: string | { embeds: any[] }): Promise<any> },
    sessionId: string,
    text: string,
    authorId: string,
    attachments: FileAttachment[] = [],
  ): Promise<void> {
    const renderer = new DiscordActivityRenderer(channel as ActivityChannel);
    try {
      const { response, recovered } = await this.sessionStore.sendOrRecover(sessionId, text, {
        attachments: attachments.length ? attachments : undefined,
        onEvent: (event) => { renderer.onEvent(event).catch(() => {}); },
        onSource: (source) => { renderer.addSource(source); },
      });
      await renderer.finishSuccess();
      const responseText = response?.data?.content ?? "";

      if (recovered) {
        log.info(`Session ${sessionId} recovered after expiry`);
        await channel.send("⚡ *Session refreshed — conversation history was reset.*").catch(() => {});
      }

      if (!responseText) return;

      const chunks = splitMessage(responseText);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const suffix = isLast && this.mentionOnReply ? `\n\n<@${authorId}>` : "";
        await channel.send(`${chunks[i]}${suffix}`);
      }

      await this.sendQueuedAttachments(channel, sessionId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Session ${sessionId} error:`, errMsg);
      await renderer.finishWithError(errMsg).catch(() => {});
      await channel.send("Sorry, something went wrong processing your message.").catch(() => {});
    }
  }

  /** Send a prompt to the agent and reply in the given channel */
  private async replyInChannel(
    channel: { send(content: string | { embeds: any[] }): Promise<any>; sendTyping?(): Promise<any> },
    sessionId: string,
    text: string,
    authorId: string,
    attachments: FileAttachment[] = [],
  ): Promise<void> {
    // Show typing indicator while processing
    const typingInterval = setInterval(() => {
      channel.sendTyping?.().catch(() => {});
    }, 8_000);
    await channel.sendTyping?.().catch(() => {});

    const renderer = new DiscordActivityRenderer(channel as ActivityChannel);
    try {
      const { response, recovered } = await this.sessionStore.sendOrRecover(sessionId, text, {
        attachments: attachments.length ? attachments : undefined,
        onEvent: (event) => { renderer.onEvent(event).catch(() => {}); },
        onSource: (source) => { renderer.addSource(source); },
      });
      await renderer.finishSuccess();
      const responseText = response?.data?.content ?? "";

      if (recovered) {
        log.info(`Session ${sessionId} recovered after expiry`);
        await channel.send("⚡ *Session refreshed — conversation history was reset.*").catch(() => {});
      }

      if (!responseText) return;

      const chunks = splitMessage(responseText);
      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;
        const suffix = isLast && this.mentionOnReply ? `\n\n<@${authorId}>` : "";
        await channel.send(`${chunks[i]}${suffix}`);
      }

      await this.sendQueuedAttachments(channel, sessionId);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error(`Session ${sessionId} error:`, errMsg);
      await renderer.finishWithError(errMsg).catch(() => {});
      await channel.send("Sorry, something went wrong processing your message.").catch(() => {});
    } finally {
      clearInterval(typingInterval);
    }
  }
}
