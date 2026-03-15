import type { CopilotSession, SessionEventHandler, AssistantMessageEvent, SessionEvent, Tool, MessageOptions } from "@github/copilot-sdk";
import { createLogger, type OctopalAgent, type Source } from "@octopal/core";

/** SDK-compatible file attachment */
export type SdkAttachment = NonNullable<MessageOptions["attachments"]>[number];

const log = createLogger("sessions");

/**
 * Maps deterministic session IDs to live SDK sessions.
 *
 * Session IDs follow the pattern `{connector}-{channelId}`:
 * - `cli-abc123` — CLI user session (token JTI)
 * - `discord-dm-123456` — Discord DM session
 * - `discord-th-789012` — Discord thread session
 */
export class SessionStore {
  private sessions = new Map<string, CopilotSession>();
  private extraTools: Tool<any>[] = [];

  constructor(private agent: OctopalAgent) {}

  /** Register extra tools that will be included in all new sessions */
  setExtraTools(tools: Tool<any>[]): void {
    this.extraTools = tools;
  }

  /** Get an existing session or create a new one */
  async getOrCreate(
    sessionId: string,
    options?: { onEvent?: SessionEventHandler },
  ): Promise<CopilotSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    // Create a new persistent session
    const session = await this.agent.createSession({
      sessionId,
      infiniteSessions: true,
      onEvent: options?.onEvent,
      extraTools: this.extraTools,
    });

    this.sessions.set(sessionId, session);
    return session;
  }

  /** Destroy a session and remove it from the store */
  async destroy(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.destroy();
      this.sessions.delete(sessionId);
    }
    this.agent.cleanupSession(sessionId);
  }

  /** Check if a session exists */
  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** List all active session IDs */
  list(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Send a prompt, automatically recovering if the SDK session expired.
   * Returns { response, recovered } — callers can notify users when recovered.
   *
   * Uses an inactivity-based timeout: the timer resets on every SDK event,
   * so long-running but active turns (tool calls, streaming) won't timeout.
   * Only truly stalled turns (no events for `inactivityTimeoutMs`) will fail.
   */
  async sendOrRecover(
    sessionId: string,
    prompt: string,
    options?: {
      attachments?: SdkAttachment[];
      onEvent?: SessionEventHandler;
      onSource?: (source: Source) => void;
      inactivityTimeoutMs?: number;
    },
  ): Promise<{ response: AssistantMessageEvent | undefined; recovered: boolean }> {
    const inactivityMs = options?.inactivityTimeoutMs ?? 300_000;
    const attachments = options?.attachments;
    const session = await this.getOrCreate(sessionId);

    // Attach per-turn event handler, capturing unsubscribe for cleanup
    const unsubEvent = options?.onEvent
      ? session.on(options.onEvent)
      : undefined;

    // Subscribe to source collector if callback provided
    const collector = options?.onSource ? this.agent.getSourceCollector(sessionId) : undefined;
    const unsubSource = collector && options?.onSource
      ? () => { collector.removeListener("source", options.onSource!); }
      : undefined;
    if (collector && options?.onSource) {
      collector.on("source", options.onSource);
    }

    const done = log.timed(`sendOrRecover ${sessionId}`, "info");
    try {
      const response = await this.sendWithActivityTimeout(session, prompt, inactivityMs, attachments);
      unsubSource?.();
      unsubEvent?.();
      done();
      return { response, recovered: false };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (message.includes("Session not found")) {
        log.info(`Session ${sessionId} expired server-side, attempting resume`);
        unsubSource?.();
        unsubEvent?.();
        // Remove stale reference but do NOT destroy — preserve events.jsonl on disk
        this.sessions.delete(sessionId);
        this.agent.cleanupSession(sessionId);

        // Try resuming the session (restores conversation history from disk)
        try {
          const resumed = await this.agent.resumeSession({
            sessionId,
            extraTools: this.extraTools,
          });
          this.sessions.set(sessionId, resumed);
          log.info(`Session ${sessionId} resumed successfully`);

          const unsubResumedEvent = options?.onEvent
            ? resumed.on(options.onEvent)
            : undefined;
          const resumedCollector = options?.onSource ? this.agent.getSourceCollector(sessionId) : undefined;
          if (resumedCollector && options?.onSource) {
            resumedCollector.on("source", options.onSource);
          }

          try {
            const response = await this.sendWithActivityTimeout(resumed, prompt, inactivityMs, attachments);
            done();
            return { response, recovered: false }; // History preserved — not a reset
          } finally {
            unsubResumedEvent?.();
            if (resumedCollector && options?.onSource) {
              resumedCollector.removeListener("source", options.onSource);
            }
          }
        } catch (resumeErr) {
          // Resume failed — fall back to fresh session
          log.warn(`Session ${sessionId} resume failed, creating fresh:`, resumeErr instanceof Error ? resumeErr.message : resumeErr);
          this.sessions.delete(sessionId);
          this.agent.cleanupSession(sessionId);

          const freshSession = await this.getOrCreate(sessionId);

          const unsubFreshEvent = options?.onEvent
            ? freshSession.on(options.onEvent)
            : undefined;
          const freshCollector = options?.onSource ? this.agent.getSourceCollector(sessionId) : undefined;
          if (freshCollector && options?.onSource) {
            freshCollector.on("source", options.onSource);
          }

          try {
            const response = await this.sendWithActivityTimeout(freshSession, prompt, inactivityMs, attachments);
            done();
            return { response, recovered: true }; // Actual reset — history lost
          } finally {
            unsubFreshEvent?.();
            if (freshCollector && options?.onSource) {
              freshCollector.removeListener("source", options.onSource);
            }
          }
        }
      }

      // On timeout or other errors, destroy the session to prevent
      // a stale session from breaking subsequent messages.
      log.warn(`Session ${sessionId} error, destroying: ${message}`);
      unsubSource?.();
      unsubEvent?.();
      // Flush any incomplete turn data before destroying
      await this.agent.flushSessionLog(sessionId).catch((e) => {
        log.warn("Failed to flush session log on error:", e);
      });
      await this.destroy(sessionId);
      done();
      throw err;
    }
  }

  /**
   * Send a prompt and wait for session.idle, resetting the timeout on every
   * event received. Unlike sendAndWait, long-running active turns won't timeout.
   */
  private sendWithActivityTimeout(
    session: CopilotSession,
    prompt: string,
    inactivityMs: number,
    attachments?: SdkAttachment[],
  ): Promise<AssistantMessageEvent | undefined> {
    return new Promise<AssistantMessageEvent | undefined>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let lastAssistantMessage: AssistantMessageEvent | undefined;
      let settled = false;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
      };

      const resetTimer = () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`Inactivity timeout after ${inactivityMs}ms with no events`));
        }, inactivityMs);
      };

      const unsubscribe = session.on((event: SessionEvent) => {
        resetTimer();
        if (event.type === "assistant.message") {
          lastAssistantMessage = event as AssistantMessageEvent;
        } else if (event.type === "session.idle") {
          cleanup();
          resolve(lastAssistantMessage);
        } else if (event.type === "session.error") {
          cleanup();
          reject(new Error((event as any).data?.message ?? "Session error"));
        }
      });

      resetTimer();
      const sendOptions: MessageOptions = { prompt };
      if (attachments?.length) sendOptions.attachments = attachments;
      session.send(sendOptions).catch((err) => {
        cleanup();
        reject(err);
      });
    });
  }

  /** Destroy all sessions */
  async destroyAll(): Promise<void> {
    for (const [id, session] of this.sessions) {
      try {
        await session.destroy();
      } catch {
        // Best-effort cleanup
      }
    }
    this.sessions.clear();
  }
}
