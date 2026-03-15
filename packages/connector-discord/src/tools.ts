import { defineTool } from "@github/copilot-sdk";
import { z } from "zod";
import { ChannelType, type Client, type TextChannel, type ThreadChannel } from "discord.js";
import { splitMessage } from "./messages.js";

export interface DiscordToolDeps {
  client: Client;
  channelIds: Set<string>;
  /** Guild IDs the bot is configured to operate in */
  guildIds: Set<string>;
  /** DM channel IDs the bot has opened (populated at runtime) */
  dmChannelIds: Set<string>;
}

/** Build Discord-specific tools for the agent */
export function buildDiscordTools({ client, channelIds, guildIds, dmChannelIds }: DiscordToolDeps) {
  /** Check if a channel/thread is allowed for tool access */
  function isAllowed(channelId: string): boolean {
    // Configured channels
    if (channelIds.has(channelId)) return true;
    // DM channels
    if (dmChannelIds.has(channelId)) return true;
    // Check channel/thread membership in configured guilds or channels
    const channel = client.channels.cache.get(channelId);
    if (channel) {
      // Guild text channel in a configured guild
      if (channel.type === ChannelType.GuildText) {
        const guildId = (channel as TextChannel).guild?.id;
        if (guildId && guildIds.has(guildId)) return true;
      }
      // Thread whose parent is a configured channel or in a configured guild
      if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
        const thread = channel as ThreadChannel;
        const parentId = thread.parentId;
        if (parentId && channelIds.has(parentId)) return true;
        const guildId = thread.guild?.id;
        if (guildId && guildIds.has(guildId)) return true;
      }
    }
    return false;
  }

  return [
    defineTool("discord_read_channel", {
      description:
        "Read metadata and recent message history from a Discord channel or thread. Only works for configured channels, their threads, and DM channels.",
      parameters: z.object({
        channelId: z.string().describe("The Discord channel or thread ID to read"),
        limit: z.number().optional().describe("Number of recent messages to fetch (default 25, max 100)"),
      }),
      handler: async ({ channelId, limit }: any) => {
        if (!isAllowed(channelId)) {
          return `Error: channel ${channelId} is not a configured channel, thread, or DM.`;
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return `Error: channel ${channelId} not found.`;

        const msgLimit = Math.min(limit ?? 25, 100);
        const sections: string[] = [];

        // Channel metadata
        if (channel.type === ChannelType.GuildText) {
          const tc = channel as TextChannel;
          sections.push(`**#${tc.name}** (text channel in ${tc.guild.name})`);
          if (tc.topic) sections.push(`Topic: ${tc.topic}`);
        } else if (channel.type === ChannelType.PublicThread || channel.type === ChannelType.PrivateThread) {
          const th = channel as ThreadChannel;
          sections.push(`**${th.name}** (thread in #${th.parent?.name ?? "unknown"})`);
        } else if (channel.type === ChannelType.DM) {
          sections.push("**DM channel**");
        } else {
          sections.push(`Channel type: ${channel.type}`);
        }

        // Fetch messages
        if ("messages" in channel) {
          const messages = await (channel as TextChannel).messages.fetch({ limit: msgLimit });
          const sorted = [...messages.values()].reverse();
          if (sorted.length > 0) {
            sections.push(`\n**Recent messages** (${sorted.length}):\n`);
            for (const msg of sorted) {
              const ts = msg.createdAt.toISOString().slice(0, 16).replace("T", " ");
              const author = msg.author.bot ? `🤖 ${msg.author.username}` : msg.author.username;
              const content = msg.content || "(no text content)";
              sections.push(`[${ts}] ${author}: ${content}`);
            }
          } else {
            sections.push("\n(no messages)");
          }
        }

        return sections.join("\n");
      },
    }),

    defineTool("discord_send_message", {
      description:
        "Send a message to a Discord channel, thread, or DM. Only works for configured channels, their threads, and DM channels.",
      parameters: z.object({
        channelId: z.string().describe("The Discord channel, thread, or DM channel ID to send to"),
        text: z.string().describe("The message text to send"),
      }),
      handler: async ({ channelId, text }: any) => {
        if (!isAllowed(channelId)) {
          return `Error: channel ${channelId} is not a configured channel, thread, or DM.`;
        }

        const channel = await client.channels.fetch(channelId).catch(() => null);
        if (!channel) return `Error: channel ${channelId} not found.`;

        if (!("send" in channel)) {
          return `Error: cannot send messages to this channel type.`;
        }

        const chunks = splitMessage(text);
        for (const chunk of chunks) {
          await (channel as TextChannel).send(chunk);
        }

        return `Sent message to channel ${channelId} (${chunks.length} chunk(s)).`;
      },
    }),

    defineTool("discord_list_channels", {
      description:
        "List all configured Discord channels and their active threads.",
      parameters: z.object({}),
      handler: async () => {
        const sections: string[] = [];

        // List explicitly configured channels
        for (const id of channelIds) {
          const channel = await client.channels.fetch(id).catch(() => null);
          if (!channel) {
            sections.push(`- ${id} (not found)`);
            continue;
          }

          if (channel.type === ChannelType.GuildText) {
            const tc = channel as TextChannel;
            let line = `- **#${tc.name}** (${tc.id}) in ${tc.guild.name}`;
            if (tc.topic) line += ` — ${tc.topic}`;
            sections.push(line);

            // List active threads
            const threads = tc.threads.cache.filter(
              (t) => !t.archived,
            );
            if (threads.size > 0) {
              for (const [, thread] of threads) {
                sections.push(`  - 🧵 **${thread.name}** (${thread.id})`);
              }
            }
          } else {
            sections.push(`- ${id} (type: ${channel.type})`);
          }
        }

        // List channels from configured guilds (if no explicit channels)
        if (channelIds.size === 0 && guildIds.size > 0) {
          for (const guildId of guildIds) {
            const guild = client.guilds.cache.get(guildId);
            if (!guild) {
              sections.push(`- Guild ${guildId} (not cached)`);
              continue;
            }
            sections.push(`**${guild.name}** (guild ${guildId}):`);
            const textChannels = guild.channels.cache.filter(
              (c) => c.type === ChannelType.GuildText,
            );
            for (const [, ch] of textChannels) {
              const tc = ch as TextChannel;
              let line = `- **#${tc.name}** (${tc.id})`;
              if (tc.topic) line += ` — ${tc.topic}`;
              sections.push(line);

              const threads = tc.threads.cache.filter((t) => !t.archived);
              for (const [, thread] of threads) {
                sections.push(`  - 🧵 **${thread.name}** (${thread.id})`);
              }
            }
          }
        }

        if (sections.length === 0) {
          return "No Discord channels or guilds are configured.";
        }

        return sections.join("\n");
      },
    }),
  ];
}
