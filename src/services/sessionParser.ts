import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  toolUse?: string[];
}

export interface SessionInfo {
  sessionId: string;
  project: string;
  projectName: string;
  resumeCommand: string;
  messages: SessionMessage[];
  messageCount: number;
  firstMessageAt: string;
  lastMessageAt: string;
  summary: string;
  hasFullConversation: boolean;
}

interface HistoryEntry {
  display: string;
  timestamp: number;
  project: string;
  sessionId: string;
}

interface ActiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
  startedAt: number;
}

const CLAUDE_DIR = join(homedir(), ".claude");
const HISTORY_FILE = join(CLAUDE_DIR, "history.jsonl");
const SESSIONS_DIR = join(CLAUDE_DIR, "sessions");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

function parseHistoryFile(): HistoryEntry[] {
  try {
    const content = readFileSync(HISTORY_FILE, "utf-8");
    return content
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function getActiveSessions(): Map<string, ActiveSession> {
  const map = new Map<string, ActiveSession>();
  try {
    const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const data: ActiveSession = JSON.parse(
        readFileSync(join(SESSIONS_DIR, file), "utf-8")
      );
      map.set(data.sessionId, data);
    }
  } catch {
    // sessions dir may not exist
  }
  return map;
}

function extractProjectName(projectPath: string): string {
  if (!projectPath) return "Unknown";
  const parts = projectPath.split("/");
  return parts[parts.length - 1] || projectPath;
}

function projectPathToSlug(projectPath: string): string {
  // /Users/foo/bar -> -Users-foo-bar
  return projectPath.replace(/\//g, "-");
}

/** Find the conversation jsonl file for a session */
function findConversationFile(sessionId: string, projectPath: string): string | null {
  if (!existsSync(PROJECTS_DIR)) return null;

  // Try the expected project slug directory first
  const slug = projectPathToSlug(projectPath);
  const directPath = join(PROJECTS_DIR, slug, `${sessionId}.jsonl`);
  if (existsSync(directPath)) return directPath;

  // Fallback: scan all project directories
  try {
    const dirs = readdirSync(PROJECTS_DIR);
    for (const dir of dirs) {
      const candidate = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Extract text content from assistant message content blocks */
function extractAssistantText(content: unknown[]): { text: string; tools: string[] } {
  const textParts: string[] = [];
  const tools: string[] = [];

  for (const block of content) {
    if (typeof block === "string") {
      textParts.push(block);
    } else if (typeof block === "object" && block !== null) {
      const b = block as Record<string, unknown>;
      if (b.type === "text" && typeof b.text === "string") {
        textParts.push(b.text);
      } else if (b.type === "tool_use" && typeof b.name === "string") {
        tools.push(b.name);
      }
    }
  }

  return { text: textParts.join("\n"), tools };
}

/** Parse the full conversation from a session jsonl file */
function parseConversationFile(filePath: string): SessionMessage[] {
  const messages: SessionMessage[] = [];
  try {
    const lines = readFileSync(filePath, "utf-8").trim().split("\n").filter(Boolean);

    for (const line of lines) {
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(line);
      } catch {
        continue;
      }

      const type = data.type as string;
      const timestamp = data.timestamp as string || "";
      const message = data.message as Record<string, unknown> | undefined;

      if (type === "user" && message) {
        const content = message.content;
        let text = "";
        if (typeof content === "string") {
          text = content;
        } else if (Array.isArray(content)) {
          text = content
            .filter((c: any) => c?.type === "text")
            .map((c: any) => c.text)
            .join("\n");
        }
        if (text) {
          messages.push({ role: "user", text, timestamp });
        }
      } else if (type === "assistant" && message) {
        const content = message.content;
        if (Array.isArray(content)) {
          const { text, tools } = extractAssistantText(content);
          if (text || tools.length > 0) {
            messages.push({
              role: "assistant",
              text: text || `（使用工具：${tools.join(", ")}）`,
              timestamp,
              toolUse: tools.length > 0 ? tools : undefined,
            });
          }
        }
      }
    }
  } catch {
    // file read error
  }
  return messages;
}

function generateSummary(messages: SessionMessage[]): string {
  const userMessages = messages
    .filter((m) => m.role === "user" && m.text && m.text !== "exit" && !m.text.startsWith("/"))
    .map((m) => m.text);

  if (userMessages.length === 0) return "（無對話內容）";

  const first = userMessages[0];
  const preview = first.length > 100 ? first.slice(0, 100) + "..." : first;

  if (userMessages.length === 1) return preview;
  return `${preview}（共 ${userMessages.length} 則對話）`;
}

export function getAllSessions(): SessionInfo[] {
  const entries = parseHistoryFile();
  const activeSessions = getActiveSessions();

  // Group history entries by session
  const sessionMap = new Map<
    string,
    { project: string; firstTs: number; lastTs: number; msgCount: number; firstUserMsg: string }
  >();

  for (const entry of entries) {
    const existing = sessionMap.get(entry.sessionId);
    if (!existing) {
      sessionMap.set(entry.sessionId, {
        project: entry.project,
        firstTs: entry.timestamp,
        lastTs: entry.timestamp,
        msgCount: 1,
        firstUserMsg: entry.display,
      });
    } else {
      existing.lastTs = Math.max(existing.lastTs, entry.timestamp);
      existing.firstTs = Math.min(existing.firstTs, entry.timestamp);
      existing.msgCount++;
      if (!existing.firstUserMsg || existing.firstUserMsg === "exit" || existing.firstUserMsg.startsWith("/")) {
        if (entry.display !== "exit" && !entry.display.startsWith("/")) {
          existing.firstUserMsg = entry.display;
        }
      }
    }
  }

  const sessions: SessionInfo[] = [];

  for (const [sessionId, data] of sessionMap) {
    const activeInfo = activeSessions.get(sessionId);
    const project = activeInfo?.cwd || data.project;
    const convFile = findConversationFile(sessionId, project);
    const hasFullConversation = convFile !== null;

    const preview = data.firstUserMsg || "（無對話內容）";
    const summary = preview.length > 100 ? preview.slice(0, 100) + "..." : preview;

    sessions.push({
      sessionId,
      project,
      projectName: extractProjectName(project),
      resumeCommand: `claude --resume ${sessionId}`,
      messages: [], // loaded on demand via getSessionById
      messageCount: data.msgCount,
      firstMessageAt: new Date(data.firstTs).toISOString(),
      lastMessageAt: new Date(data.lastTs).toISOString(),
      summary: data.msgCount > 1 ? `${summary}（共 ${data.msgCount} 則對話）` : summary,
      hasFullConversation,
    });
  }

  return sessions.sort(
    (a, b) => new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
  );
}

export interface SearchMatch {
  role: "user" | "assistant";
  snippet: string;
  timestamp: string;
}

export interface SessionSearchResult extends SessionInfo {
  matches: SearchMatch[];
}

/** Extract a snippet around the first occurrence of query in text */
function extractSnippet(text: string, query: string, contextLen = 80): string {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, contextLen * 2);
  const start = Math.max(0, idx - contextLen);
  const end = Math.min(text.length, idx + query.length + contextLen);
  return (start > 0 ? "..." : "") + text.slice(start, end) + (end < text.length ? "..." : "");
}

export function searchSessions(query: string): SessionSearchResult[] {
  if (!query.trim()) return [];
  const q = query.toLowerCase();
  const all = getAllSessions();
  const results: SessionSearchResult[] = [];

  for (const session of all) {
    const matches: SearchMatch[] = [];

    // Always check project path and summary (fast, no file I/O)
    if (session.project.toLowerCase().includes(q) || session.summary.toLowerCase().includes(q)) {
      matches.push({
        role: "user",
        snippet: extractSnippet(session.summary, query),
        timestamp: session.firstMessageAt,
      });
    }

    // Search full conversation if available
    if (session.hasFullConversation) {
      const convFile = findConversationFile(session.sessionId, session.project);
      if (convFile) {
        const messages = parseConversationFile(convFile);
        for (const msg of messages) {
          if (msg.text.toLowerCase().includes(q)) {
            // Avoid duplicate if already matched summary
            const isDupeSummary = matches.length > 0 && msg.role === "user" &&
              session.summary.toLowerCase().includes(q);
            if (!isDupeSummary) {
              matches.push({
                role: msg.role,
                snippet: extractSnippet(msg.text, query),
                timestamp: msg.timestamp,
              });
            }
            if (matches.length >= 3) break; // cap at 3 snippets per session
          }
        }
      }
    }

    if (matches.length > 0) {
      results.push({ ...session, matches });
    }
  }

  return results;
}

export interface DailyUsageSession {
  sessionId: string;
  project: string;
  projectName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  messageCount: number;
  model: string;
}

export interface DailyUsage {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalTokens: number;
  totalMessages: number;
  sessionCount: number;
  sessions: DailyUsageSession[];
}

export function getDailyUsage(dateStr?: string): DailyUsage {
  const targetDate = dateStr || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const dayStart = new Date(targetDate + "T00:00:00").getTime();
  const dayEnd = new Date(targetDate + "T23:59:59.999").getTime();

  const entries = parseHistoryFile();
  // Find sessions active on the target date
  const sessionIds = new Set<string>();
  const sessionProjects = new Map<string, string>();

  for (const entry of entries) {
    if (entry.timestamp >= dayStart && entry.timestamp <= dayEnd) {
      sessionIds.add(entry.sessionId);
      if (!sessionProjects.has(entry.sessionId)) {
        sessionProjects.set(entry.sessionId, entry.project);
      }
    }
  }

  const sessions: DailyUsageSession[] = [];
  let totalInput = 0, totalOutput = 0, totalCacheCreate = 0, totalCacheRead = 0, totalMessages = 0;

  for (const sessionId of sessionIds) {
    const project = sessionProjects.get(sessionId) || "";
    const convFile = findConversationFile(sessionId, project);
    if (!convFile) continue;

    let sessionInput = 0, sessionOutput = 0, sessionCacheCreate = 0, sessionCacheRead = 0;
    let sessionMsgCount = 0;
    let model = "";

    try {
      const lines = readFileSync(convFile, "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        let data: Record<string, unknown>;
        try { data = JSON.parse(line); } catch { continue; }

        const ts = data.timestamp as string;
        if (!ts) continue;
        const msgTime = new Date(ts).getTime();
        if (msgTime < dayStart || msgTime > dayEnd) continue;

        if (data.type === "assistant" && data.message) {
          const msg = data.message as Record<string, unknown>;
          const usage = msg.usage as Record<string, number> | undefined;
          if (usage) {
            sessionInput += usage.input_tokens || 0;
            sessionOutput += usage.output_tokens || 0;
            sessionCacheCreate += usage.cache_creation_input_tokens || 0;
            sessionCacheRead += usage.cache_read_input_tokens || 0;
            sessionMsgCount++;
            if (!model && msg.model) model = msg.model as string;
          }
        }
      }
    } catch {
      continue;
    }

    if (sessionMsgCount > 0) {
      const total = sessionInput + sessionOutput + sessionCacheCreate + sessionCacheRead;
      sessions.push({
        sessionId,
        project,
        projectName: extractProjectName(project),
        inputTokens: sessionInput,
        outputTokens: sessionOutput,
        cacheCreationTokens: sessionCacheCreate,
        cacheReadTokens: sessionCacheRead,
        totalTokens: total,
        messageCount: sessionMsgCount,
        model,
      });
      totalInput += sessionInput;
      totalOutput += sessionOutput;
      totalCacheCreate += sessionCacheCreate;
      totalCacheRead += sessionCacheRead;
      totalMessages += sessionMsgCount;
    }
  }

  // Sort by total tokens descending
  sessions.sort((a, b) => b.totalTokens - a.totalTokens);

  return {
    date: targetDate,
    totalInputTokens: totalInput,
    totalOutputTokens: totalOutput,
    totalCacheCreationTokens: totalCacheCreate,
    totalCacheReadTokens: totalCacheRead,
    totalTokens: totalInput + totalOutput + totalCacheCreate + totalCacheRead,
    totalMessages,
    sessionCount: sessions.length,
    sessions,
  };
}

export function getSessionById(id: string): (SessionInfo & { messages: SessionMessage[] }) | undefined {
  const entries = parseHistoryFile();
  const activeSessions = getActiveSessions();

  // Find the session in history
  const sessionEntries = entries.filter((e) => e.sessionId === id);
  if (sessionEntries.length === 0) return undefined;

  const project =
    activeSessions.get(id)?.cwd || sessionEntries[0].project;

  // Try to load full conversation
  const convFile = findConversationFile(id, project);
  let messages: SessionMessage[];

  if (convFile) {
    messages = parseConversationFile(convFile);
  } else {
    // Fallback to history-only (user messages only)
    messages = sessionEntries
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((e) => ({
        role: "user" as const,
        text: e.display,
        timestamp: new Date(e.timestamp).toISOString(),
      }));
  }

  const timestamps = sessionEntries.map((e) => e.timestamp);

  return {
    sessionId: id,
    project,
    projectName: extractProjectName(project),
    resumeCommand: `claude --resume ${id}`,
    messages,
    messageCount: messages.length,
    firstMessageAt: new Date(Math.min(...timestamps)).toISOString(),
    lastMessageAt: new Date(Math.max(...timestamps)).toISOString(),
    summary: generateSummary(messages),
    hasFullConversation: convFile !== null,
  };
}
