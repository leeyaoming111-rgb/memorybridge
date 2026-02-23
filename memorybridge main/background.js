/**
 * MemoryBridge — Background Service Worker
 * 
 * Manages conversation storage, the distillation pipeline
 * (raw conversations → structured memory profile), and
 * communication between content scripts and popup.
 * 
 * Supports both API-key and session-based distillation.
 * Session mode piggybacks on the user's existing chatbot login
 * via the content script (no API key needed).
 */

// ─── Constants ─────────────────────────────────────────────────
const STORAGE_KEYS = {
  CONVERSATIONS: "mb_conversations",
  MEMORY_PROFILE: "mb_memory_profile",
  RAW_BUFFER: "mb_raw_buffer",
  SETTINGS: "mb_settings",
  STATS: "mb_stats",
  UPDATE_INFO: "mb_update_info"
};

// ── Update Config ──────────────────────────────────────────────
// Point this at your hosted update manifest (GitHub raw URL works great).
// Set to "" to disable update checks entirely.
const UPDATE_MANIFEST_URL = "https://raw.githubusercontent.com/leeyaoming111-rgb/memorybridge/main/update.json";
const UPDATE_CHECK_INTERVAL_HOURS = 6;
const CURRENT_VERSION = "0.5.0";

const DEFAULT_SETTINGS = {
  captureEnabled: true,
  apiProvider: "session_claude",
  apiKey: "",
  autoDistill: true,
  distillThreshold: 20,
  model: "claude-sonnet-4-20250514"
};

const DEFAULT_MEMORY_PROFILE = {
  version: 2,
  lastUpdated: null,
  // ── HIGH PRIORITY: These directly improve response quality ──
  interaction_preferences: {
    // How they want to receive information
    learning_style: [],       // e.g. "learns through analogies", "prefers visual diagrams"
    response_format: [],      // e.g. "code first then explanation", "concise bullet points"
    tone: [],                 // e.g. "casual and direct", "no corporate speak"
    pet_peeves: [],           // e.g. "hates excessive caveats", "dislikes being asked too many clarifying questions"
    likes: [],                // e.g. "appreciates when AI challenges their assumptions", "loves concrete examples"
    depth: null,              // "surface" | "moderate" | "deep" | "exhaustive"
    verbosity: null,          // "minimal" | "concise" | "moderate" | "detailed"
  },
  // How they communicate (helps AI match their style)
  communication_patterns: {
    tone: null,               // description of how they write
    vocabulary_level: null,   // "casual" | "technical" | "mixed"
    asks_questions_like: [],  // patterns in how they phrase requests
    gives_feedback_like: [],  // how they signal satisfaction/dissatisfaction
  },
  // ── MEDIUM PRIORITY: Useful context ──
  expertise: [],              // [{ domain, level, notes }] — helps calibrate explanations
  active_projects: [],        // [{ name, context }] — only current/recent, brief
  tools_and_stack: [],        // languages, frameworks, tools they actively use
  // ── LOW PRIORITY: Background info ──
  identity: {},               // name, location, occupation — light touch
  interests: [],              // broad topic interests
  facts: [],                  // miscellaneous facts with confidence scores
  context_notes: []           // anything else useful
};

const DEFAULT_STATS = {
  totalMessages: 0,
  totalConversations: 0,
  totalDistillations: 0,
  messagesByProvider: {},
  lastCapture: null,
  lastDistillation: null
};

// ─── Initialization ────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.MEMORY_PROFILE,
    STORAGE_KEYS.STATS,
    STORAGE_KEYS.RAW_BUFFER
  ]);

  if (!existing[STORAGE_KEYS.SETTINGS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  if (!existing[STORAGE_KEYS.MEMORY_PROFILE]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.MEMORY_PROFILE]: DEFAULT_MEMORY_PROFILE });
  }
  if (!existing[STORAGE_KEYS.STATS]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: DEFAULT_STATS });
  }
  if (!existing[STORAGE_KEYS.RAW_BUFFER]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.RAW_BUFFER]: [] });
  }

  console.log("[MemoryBridge] Extension installed and initialized.");
});

// ─── Update Checker ────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  if (UPDATE_MANIFEST_URL) {
    chrome.alarms.create("mb_update_check", {
      delayInMinutes: 1, // check shortly after install
      periodInMinutes: UPDATE_CHECK_INTERVAL_HOURS * 60
    });
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mb_update_check") {
    checkForUpdate().catch(err => {
      console.warn("[MemoryBridge] Update check failed:", err.message);
    });
  }
});

async function checkForUpdate() {
  if (!UPDATE_MANIFEST_URL) return { error: "No update URL configured" };

  try {
    const resp = await fetch(UPDATE_MANIFEST_URL, { cache: "no-store" });
    if (!resp.ok) return { error: `HTTP ${resp.status} fetching update.json` };
    const manifest = await resp.json();

    const updateInfo = {
      checkedAt: Date.now(),
      latestVersion: manifest.version,
      downloadUrl: manifest.download_url || null,
      changelog: manifest.changelog || "",
      updateAvailable: isNewerVersion(manifest.version, CURRENT_VERSION),
      currentVersion: CURRENT_VERSION
    };

    await chrome.storage.local.set({ [STORAGE_KEYS.UPDATE_INFO]: updateInfo });

    if (updateInfo.updateAvailable) {
      chrome.action.setBadgeText({ text: "↑" });
      chrome.action.setBadgeBackgroundColor({ color: "#FBBF24" });
      console.log(`[MemoryBridge] Update available: ${CURRENT_VERSION} → ${manifest.version}`);
    }

    return updateInfo;
  } catch (err) {
    console.warn("[MemoryBridge] Update check failed:", err.message);
    return { error: err.message };
  }
}

function isNewerVersion(latest, current) {
  const parse = v => v.replace(/^v/, "").split(".").map(Number);
  const l = parse(latest);
  const c = parse(current);
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const lv = l[i] || 0;
    const cv = c[i] || 0;
    if (lv > cv) return true;
    if (lv < cv) return false;
  }
  return false;
}

// ─── Message Router ────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse).catch(err => {
    console.error("[MemoryBridge] Message handler error:", err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(msg, sender) {
  switch (msg.type) {
    case "NEW_MESSAGE":
      return await handleNewMessage(msg.payload);
    case "NEW_CONVERSATION":
      return await handleNewConversation(msg.payload);
    case "CONTENT_SCRIPT_READY":
      return { acknowledged: true };
    case "UPDATE_BADGE":
      setBadgeCount(msg.payload.count);
      return { ok: true };
    case "GET_MEMORY_PROFILE":
      return await getMemoryProfile();
    case "GET_STATS":
      return await getStats();
    case "GET_SETTINGS":
      return await getSettings();
    case "SAVE_SETTINGS":
      return await saveSettings(msg.payload);
    case "TRIGGER_DISTILL":
      return await runDistillation();
    case "GET_RAW_BUFFER":
      return await getRawBuffer();
    case "EXPORT_PROFILE":
      return await exportProfile();
    case "IMPORT_PROFILE":
      return await importProfile(msg.payload);
    case "CLEAR_ALL_DATA":
      return await clearAllData();
    case "GET_CONTEXT_PROMPT":
      return await generateContextPrompt();
    case "CLEAR_RAW_BUFFER":
      await chrome.storage.local.set({ [STORAGE_KEYS.RAW_BUFFER]: [] });
      return { success: true };
    case "GET_UPDATE_INFO":
      return await getUpdateInfo();
    case "CHECK_FOR_UPDATE":
      return await checkForUpdate();
    case "DISMISS_UPDATE":
      const uInfo = await getUpdateInfo();
      if (uInfo) {
        uInfo.dismissed = true;
        await chrome.storage.local.set({ [STORAGE_KEYS.UPDATE_INFO]: uInfo });
      }
      chrome.action.setBadgeText({ text: "" });
      return { ok: true };
    default:
      return { error: `Unknown message type: ${msg.type}` };
  }
}

// ─── Message Handling ──────────────────────────────────────────
async function handleNewMessage(payload) {
  const { conversationId, provider, providerName, message, url, pageTitle } = payload;

  const bufferEntry = {
    conversationId, provider, providerName,
    role: message.role, text: message.text,
    timestamp: message.timestamp, url
  };

  const result = await chrome.storage.local.get([STORAGE_KEYS.RAW_BUFFER, STORAGE_KEYS.STATS, STORAGE_KEYS.SETTINGS]);
  const buffer = result[STORAGE_KEYS.RAW_BUFFER] || [];
  const stats = result[STORAGE_KEYS.STATS] || DEFAULT_STATS;
  const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;

  const isDuplicate = buffer.some(b =>
    b.conversationId === conversationId &&
    b.role === message.role &&
    b.text === message.text
  );
  if (isDuplicate) {
    return { stored: false, bufferSize: buffer.length, reason: "duplicate" };
  }

  buffer.push(bufferEntry);
  stats.totalMessages++;
  stats.messagesByProvider[provider] = (stats.messagesByProvider[provider] || 0) + 1;
  stats.lastCapture = Date.now();

  await chrome.storage.local.set({
    [STORAGE_KEYS.RAW_BUFFER]: buffer,
    [STORAGE_KEYS.STATS]: stats
  });

  // Auto-distill — session modes don't need an API key
  const isSession = settings.apiProvider?.startsWith("session_");
  const canDistill = isSession || settings.apiKey;
  if (settings.autoDistill && canDistill && buffer.length >= settings.distillThreshold) {
    runDistillation().catch(err => {
      console.error("[MemoryBridge] Auto-distill error:", err);
    });
  }

  return { stored: true, bufferSize: buffer.length };
}

async function handleNewConversation(payload) {
  const result = await chrome.storage.local.get([STORAGE_KEYS.STATS]);
  const stats = result[STORAGE_KEYS.STATS] || DEFAULT_STATS;
  stats.totalConversations++;
  await chrome.storage.local.set({ [STORAGE_KEYS.STATS]: stats });
  return { ok: true };
}

// ─── Distillation Pipeline ─────────────────────────────────────
const DISTILL_SYSTEM_PROMPT = `You are a memory distillation engine for MemoryBridge. Your job is to analyze conversations between a user and AI assistants and extract a profile that will make future AI interactions better for this specific person.

CRITICAL PRIORITY: Focus on HOW the user wants to interact, not WHAT projects they've done. The goal is to build a profile that, when given to a new AI, makes it respond in ways this person finds more useful and natural.

## What to look for (in priority order):

### 1. INTERACTION PREFERENCES (most important — spend 60% of your effort here)
Read between the lines. Look for signals like:
- User rephrases a question → the AI's format/depth wasn't right
- User says "shorter", "too long", "more detail" → verbosity preference  
- User says "just show me the code", "explain first" → response format preference
- User says "like an analogy" or responds well to analogies → learning style
- User pushes back on caveats/hedging → pet peeve about hedging
- User says "don't ask, just do it" → prefers action over clarifying questions
- User responds with "perfect" or "exactly" → the preceding AI response format was ideal
- User skips/ignores parts of a response → those parts weren't useful to them
- User's own writing style → they probably prefer similar tone back

Extract these as concrete, specific, actionable preferences. NOT vague things like "prefers good responses." Instead: "learns technical concepts best through real-world analogies", "wants code shown before any explanation", "dislikes when AI adds safety caveats to straightforward technical questions."

### 2. COMMUNICATION PATTERNS (20% of effort)  
How does the user actually write? Short fragments? Formal? Casual? Technical jargon? Emoji? This helps the AI match their vibe.

### 3. EXPERTISE & TOOLS (15% of effort)
What's their skill level in relevant domains? What tools/languages do they use? This calibrates explanation depth. Keep it brief — just domain + level.

### 4. IDENTITY & FACTS (5% of effort)  
Name, job, location — only if explicitly mentioned. Don't dig for biographical details. Skip project histories unless a project is actively being discussed and ongoing.

## Output Format
Return ONLY valid JSON:

{
  "interaction_preferences": {
    "learning_style": ["specific preference strings — be concrete and actionable"],
    "response_format": ["e.g. code first then explanation", "prefers inline comments over separate docs"],
    "tone": ["e.g. casual and direct", "match their informal writing style"],
    "pet_peeves": ["e.g. hates excessive hedging", "dislikes being asked obvious clarifying questions"],
    "likes": ["e.g. appreciates when AI suggests alternatives they didn't consider"],
    "depth": "surface | moderate | deep | exhaustive",
    "verbosity": "minimal | concise | moderate | detailed"
  },
  "communication_patterns": {
    "tone": "description of how they communicate",
    "vocabulary_level": "casual | technical | mixed",
    "asks_questions_like": ["patterns in how they phrase things"],
    "gives_feedback_like": ["how they signal happy/unhappy"]
  },
  "expertise": [
    { "domain": "string", "level": "beginner | intermediate | advanced | expert", "notes": "brief" }
  ],
  "active_projects": [
    { "name": "string", "context": "one line description" }
  ],
  "tools_and_stack": ["language/framework/tool names"],
  "identity": {
    "name": "string or null",
    "location": "string or null",  
    "occupation": "string or null"
  },
  "interests": ["array of topic strings"],
  "facts": [
    { "category": "string", "fact": "string", "confidence": 0.0-1.0 }
  ],
  "context_notes": ["anything else useful"]
}

## Rules
- Be SPECIFIC and ACTIONABLE in preference strings. "Prefers concise" is weak. "Wants max 2-3 sentences per explanation unless they ask for more" is strong.
- Only extract what's evidenced — never assume or invent
- If a conversation is purely Q&A with no preference signals, return minimal/empty fields — don't pad
- Merge with existing profile: reinforce patterns you see repeated, update things that seem to have changed
- Confidence scores: >0.8 only if explicitly stated by user; 0.5-0.8 if strongly implied; <0.5 if weak signal
- Omit empty arrays and null fields entirely
- Keep facts atomic, one per entry
- For active_projects, only include things currently being worked on, not historical projects`;

async function runDistillation() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.RAW_BUFFER, STORAGE_KEYS.MEMORY_PROFILE,
    STORAGE_KEYS.SETTINGS, STORAGE_KEYS.STATS
  ]);

  const buffer = result[STORAGE_KEYS.RAW_BUFFER] || [];
  const existingProfile = result[STORAGE_KEYS.MEMORY_PROFILE] || DEFAULT_MEMORY_PROFILE;
  const settings = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
  const stats = result[STORAGE_KEYS.STATS] || DEFAULT_STATS;

  if (buffer.length === 0) {
    return { success: false, error: "No messages in buffer to distill" };
  }

  const isSession = settings.apiProvider?.startsWith("session_");
  if (!isSession && !settings.apiKey) {
    return { success: false, error: "No API key configured. Use 'Browser Session' mode or add an API key." };
  }

  const conversationText = buffer.map(b =>
    `[${b.providerName}] ${b.role.toUpperCase()}: ${b.text}`
  ).join("\n\n");

  const userPrompt = `Here is my existing profile (merge with this, don't duplicate):

${JSON.stringify(existingProfile, null, 2)}

---

Here are the new conversation excerpts to analyze:

${conversationText}`;

  try {
    let newProfile;

    if (settings.apiProvider === "session_claude") {
      newProfile = await callSessionClaude(userPrompt);
    } else if (settings.apiProvider === "session_chatgpt") {
      newProfile = await callSessionChatGPT(userPrompt);
    } else if (settings.apiProvider === "openai") {
      newProfile = await callOpenAI(settings, userPrompt);
    } else {
      newProfile = await callAnthropic(settings, userPrompt);
    }

    if (!newProfile) {
      return { success: false, error: "Failed to parse distillation response" };
    }

    const merged = mergeProfiles(existingProfile, newProfile);
    merged.lastUpdated = Date.now();
    stats.totalDistillations++;
    stats.lastDistillation = Date.now();

    await chrome.storage.local.set({
      [STORAGE_KEYS.MEMORY_PROFILE]: merged,
      [STORAGE_KEYS.RAW_BUFFER]: [],
      [STORAGE_KEYS.STATS]: stats
    });

    return { success: true, profile: merged };

  } catch (err) {
    console.error("[MemoryBridge] Distillation error:", err);
    return { success: false, error: err.message };
  }
}

// ─── Session-Based Distillation (runs in background, no tab needed) ──

async function callSessionClaude(userPrompt) {
  console.log("[MemoryBridge] Session distilling via Claude (background)...");
  const fullPrompt = `${DISTILL_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  // Step 1: Get organization ID
  const orgsResp = await fetch("https://claude.ai/api/organizations", {
    credentials: "include"
  });
  if (!orgsResp.ok) throw new Error(`Claude orgs failed (${orgsResp.status}). Are you logged into claude.ai?`);
  const orgs = await orgsResp.json();
  const orgId = orgs[0]?.uuid;
  if (!orgId) throw new Error("No Claude org found. Make sure you're logged in.");

  // Step 2: Create temporary conversation
  const convUuid = crypto.randomUUID();
  const createResp = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "", uuid: convUuid })
  });
  if (!createResp.ok) throw new Error(`Claude create conversation failed (${createResp.status})`);
  const conv = await createResp.json();
  const convId = conv.uuid;

  try {
    // Step 3: Send prompt
    const completionResp = await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}/completion`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: fullPrompt,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        attachments: [],
        files: []
      })
    });
    if (!completionResp.ok) throw new Error(`Claude completion failed (${completionResp.status})`);

    // Step 4: Read SSE stream
    const fullText = await readSSEStream(completionResp);
    console.log("[MemoryBridge] Claude distill done, length:", fullText.length);
    return parseJSON(fullText);

  } finally {
    // Always clean up
    try {
      await fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}`, {
        method: "DELETE", credentials: "include"
      });
    } catch (_) {}
  }
}

async function callSessionChatGPT(userPrompt) {
  console.log("[MemoryBridge] Session distilling via ChatGPT (background)...");
  const fullPrompt = `${DISTILL_SYSTEM_PROMPT}\n\n---\n\n${userPrompt}`;

  // Step 1: Get access token
  let accessToken = null;
  try {
    const sessionResp = await fetch("https://chatgpt.com/api/auth/session", {
      credentials: "include",
      headers: { "Accept": "application/json" }
    });
    if (sessionResp.ok) {
      const session = await sessionResp.json();
      accessToken = session.accessToken;
    }
  } catch (_) {}

  if (!accessToken) {
    throw new Error("Can't get ChatGPT auth. Make sure you're logged in at chatgpt.com.");
  }

  // Step 2: Get device ID from cookie
  let deviceId = null;
  try {
    const cookie = await chrome.cookies.get({ url: "https://chatgpt.com", name: "oai-did" });
    if (cookie) deviceId = cookie.value;
  } catch (_) {}
  if (!deviceId) deviceId = crypto.randomUUID();

  // Step 3: Send conversation request
  const messageId = crypto.randomUUID();
  const parentId = crypto.randomUUID();

  const convResp = await fetch("https://chatgpt.com/backend-api/conversation", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
      "Authorization": `Bearer ${accessToken}`,
      "oai-device-id": deviceId,
      "oai-language": "en-US"
    },
    body: JSON.stringify({
      action: "next",
      messages: [{
        id: messageId,
        author: { role: "user" },
        content: { content_type: "text", parts: [fullPrompt] },
        metadata: {}
      }],
      parent_message_id: parentId,
      model: "auto",
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: true,
      conversation_mode: { kind: "primary_assistant" },
      force_paragen: false,
      force_rate_limit: false,
      websocket_request_id: crypto.randomUUID()
    })
  });

  if (!convResp.ok) {
    const errText = await convResp.text().catch(() => "");
    throw new Error(`ChatGPT failed (${convResp.status}): ${errText.slice(0, 200)}`);
  }

  // Step 4: Read SSE stream
  const { text: fullText, conversationId: gptConvId } = await readChatGPTSSE(convResp);

  // Step 5: Hide temp conversation
  if (gptConvId) {
    try {
      await fetch(`https://chatgpt.com/backend-api/conversation/${gptConvId}`, {
        method: "PATCH",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${accessToken}`
        },
        body: JSON.stringify({ is_visible: false })
      });
    } catch (_) {}
  }

  console.log("[MemoryBridge] ChatGPT distill done, length:", fullText.length);
  return parseJSON(fullText);
}

// ─── SSE Stream Readers ────────────────────────────────────────

async function readSSEStream(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.completion) fullText += data.completion;
        else if (data.delta?.text) fullText += data.delta.text;
        else if (data.type === "content_block_delta" && data.delta?.text) fullText += data.delta.text;
      } catch (_) {}
    }
  }
  return fullText;
}

async function readChatGPTSSE(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  let buffer = "";
  let gptConvId = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const jsonStr = line.slice(6).trim();
      if (!jsonStr || jsonStr === "[DONE]") continue;
      try {
        const data = JSON.parse(jsonStr);
        if (data.conversation_id) gptConvId = data.conversation_id;
        const parts = data.message?.content?.parts;
        if (parts?.length > 0 && typeof parts[0] === "string") {
          fullText = parts[0];
        }
      } catch (_) {}
    }
  }
  return { text: fullText, conversationId: gptConvId };
}

// ─── API-Key Based Distillation ────────────────────────────────

async function callAnthropic(settings, userPrompt) {
  const model = settings.model || "claude-sonnet-4-20250514";
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system: DISTILL_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userPrompt }]
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return parseJSON(data.content?.[0]?.text || "");
}

async function callOpenAI(settings, userPrompt) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      max_tokens: 4096,
      messages: [
        { role: "system", content: DISTILL_SYSTEM_PROMPT },
        { role: "user", content: userPrompt }
      ]
    })
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error ${resp.status}: ${errText}`);
  }
  const data = await resp.json();
  return parseJSON(data.choices?.[0]?.message?.content || "");
}

function parseJSON(text) {
  let cleaned = text.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (_) {}
    }
    console.error("[MemoryBridge] Failed to parse JSON:", cleaned.slice(0, 200));
    return null;
  }
}

// ─── Profile Merging ──────────────────────────────────────────
function mergeProfiles(existing, incoming) {
  const merged = JSON.parse(JSON.stringify(existing));
  merged.version = 2;

  // ── Interaction Preferences (the important stuff) ──
  if (incoming.interaction_preferences) {
    const ip = incoming.interaction_preferences;
    if (!merged.interaction_preferences) merged.interaction_preferences = {};
    const mip = merged.interaction_preferences;

    const arrayFields = ["learning_style", "response_format", "tone", "pet_peeves", "likes"];
    for (const field of arrayFields) {
      if (ip[field]?.length) {
        mip[field] = dedupeArray([...(mip[field] || []), ...ip[field]]).slice(0, 20);
      }
    }
    if (ip.depth) mip.depth = ip.depth;
    if (ip.verbosity) mip.verbosity = ip.verbosity;
  }

  // ── Communication Patterns ──
  if (incoming.communication_patterns) {
    const cp = incoming.communication_patterns;
    if (!merged.communication_patterns) merged.communication_patterns = {};
    const mcp = merged.communication_patterns;

    if (cp.tone) mcp.tone = cp.tone;
    if (cp.vocabulary_level) mcp.vocabulary_level = cp.vocabulary_level;
    if (cp.asks_questions_like?.length) {
      mcp.asks_questions_like = dedupeArray([...(mcp.asks_questions_like || []), ...cp.asks_questions_like]).slice(0, 10);
    }
    if (cp.gives_feedback_like?.length) {
      mcp.gives_feedback_like = dedupeArray([...(mcp.gives_feedback_like || []), ...cp.gives_feedback_like]).slice(0, 10);
    }
  }

  // ── Expertise ──
  merged.expertise = mergeByKey(existing.expertise || [], incoming.expertise || [], "domain").slice(0, 30);

  // ── Active Projects (current only, replace stale) ──
  if (incoming.active_projects?.length) {
    merged.active_projects = mergeByKey(merged.active_projects || [], incoming.active_projects, "name").slice(0, 10);
  }

  // ── Tools & Stack ──
  if (incoming.tools_and_stack?.length) {
    merged.tools_and_stack = dedupeArray([...(merged.tools_and_stack || []), ...incoming.tools_and_stack]).slice(0, 30);
  }

  // ── Identity (light touch) ──
  if (incoming.identity) {
    merged.identity = { ...merged.identity, ...incoming.identity };
    for (const k of Object.keys(merged.identity)) {
      if (merged.identity[k] === null) delete merged.identity[k];
    }
  }

  // ── Lower priority ──
  merged.interests = dedupeArray([...(existing.interests || []), ...(incoming.interests || [])]).slice(0, 30);
  merged.facts = mergeFacts(existing.facts || [], incoming.facts || []).slice(0, 50);
  merged.context_notes = dedupeArray([...(existing.context_notes || []), ...(incoming.context_notes || [])]).slice(0, 20);

  // ── Migrate v1 fields if present ──
  if (existing.preferences) {
    if (!merged.interaction_preferences) merged.interaction_preferences = {};
    const mip = merged.interaction_preferences;
    if (existing.preferences.response_length && !mip.verbosity) mip.verbosity = existing.preferences.response_length;
    if (existing.preferences.formality) {
      mip.tone = dedupeArray([...(mip.tone || []), existing.preferences.formality + " tone"]);
    }
    if (existing.preferences.other?.length) {
      mip.likes = dedupeArray([...(mip.likes || []), ...existing.preferences.other]);
    }
    delete merged.preferences;
  }
  if (existing.communication_style) {
    if (!merged.communication_patterns) merged.communication_patterns = {};
    const mcp = merged.communication_patterns;
    if (existing.communication_style.tone && !mcp.tone) mcp.tone = existing.communication_style.tone;
    if (existing.communication_style.vocabulary_level && !mcp.vocabulary_level) mcp.vocabulary_level = existing.communication_style.vocabulary_level;
    if (existing.communication_style.patterns?.length) {
      mcp.asks_questions_like = dedupeArray([...(mcp.asks_questions_like || []), ...existing.communication_style.patterns]);
    }
    delete merged.communication_style;
  }
  if (existing.recurring_topics) delete merged.recurring_topics;

  return merged;
}

function dedupeArray(arr) {
  return [...new Set(arr.map(s => typeof s === "string" ? s.trim() : s))].filter(Boolean);
}

function mergeByKey(existing, incoming, key) {
  const map = new Map();
  existing.forEach(item => map.set(item[key]?.toLowerCase(), item));
  incoming.forEach(item => {
    const k = item[key]?.toLowerCase();
    if (map.has(k)) map.set(k, { ...map.get(k), ...item });
    else map.set(k, item);
  });
  return Array.from(map.values());
}

function mergeFacts(existing, incoming) {
  const merged = [...existing];
  for (const newFact of incoming) {
    const isDuplicate = merged.some(f =>
      f.fact.toLowerCase().includes(newFact.fact.toLowerCase().slice(0, 30)) ||
      newFact.fact.toLowerCase().includes(f.fact.toLowerCase().slice(0, 30))
    );
    if (!isDuplicate) merged.push(newFact);
  }
  return merged;
}

// ─── Context Prompt Generation ────────────────────────────────
async function generateContextPrompt() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.MEMORY_PROFILE]);
  const profile = result[STORAGE_KEYS.MEMORY_PROFILE] || DEFAULT_MEMORY_PROFILE;

  let prompt = "## How to interact with me (from MemoryBridge)\n\n";

  // ── Interaction Preferences (lead with this — it's the whole point) ──
  const ip = profile.interaction_preferences || {};
  const hasPrefs = ip.learning_style?.length || ip.response_format?.length ||
    ip.tone?.length || ip.pet_peeves?.length || ip.likes?.length ||
    ip.depth || ip.verbosity;

  if (hasPrefs) {
    if (ip.learning_style?.length) {
      prompt += "**How I learn best:** " + ip.learning_style.join("; ") + "\n\n";
    }
    if (ip.response_format?.length) {
      prompt += "**How I want responses structured:** " + ip.response_format.join("; ") + "\n\n";
    }
    if (ip.verbosity || ip.depth) {
      const parts = [];
      if (ip.verbosity) parts.push(`verbosity: ${ip.verbosity}`);
      if (ip.depth) parts.push(`depth: ${ip.depth}`);
      prompt += "**Response calibration:** " + parts.join(", ") + "\n\n";
    }
    if (ip.tone?.length) {
      prompt += "**Tone I prefer:** " + ip.tone.join("; ") + "\n\n";
    }
    if (ip.likes?.length) {
      prompt += "**Things I appreciate:** " + ip.likes.join("; ") + "\n\n";
    }
    if (ip.pet_peeves?.length) {
      prompt += "**Things to avoid (my pet peeves):** " + ip.pet_peeves.join("; ") + "\n\n";
    }
  }

  // ── Communication Patterns ──
  const cp = profile.communication_patterns || {};
  if (cp.tone || cp.vocabulary_level) {
    let commLine = "**My communication style:** ";
    const parts = [];
    if (cp.tone) parts.push(cp.tone);
    if (cp.vocabulary_level) parts.push(`vocabulary: ${cp.vocabulary_level}`);
    prompt += commLine + parts.join("; ") + "\n\n";
  }

  // ── Expertise & Tools (calibration) ──
  if (profile.expertise?.length) {
    prompt += "**My expertise levels** (calibrate explanations accordingly):\n";
    profile.expertise.forEach(e => {
      prompt += `- ${e.domain}: ${e.level}${e.notes ? " — " + e.notes : ""}\n`;
    });
    prompt += "\n";
  }

  if (profile.tools_and_stack?.length) {
    prompt += "**Tools & tech I use:** " + profile.tools_and_stack.join(", ") + "\n\n";
  }

  // ── Active Projects (if any) ──
  if (profile.active_projects?.length) {
    prompt += "**What I'm currently working on:**\n";
    profile.active_projects.forEach(p => {
      prompt += `- ${p.name}${p.context ? ": " + p.context : ""}\n`;
    });
    prompt += "\n";
  }

  // ── Identity (brief) ──
  const id = profile.identity || {};
  if (Object.keys(id).length > 0) {
    const parts = [];
    if (id.name) parts.push(`Name: ${id.name}`);
    if (id.occupation) parts.push(id.occupation);
    if (id.location) parts.push(`based in ${id.location}`);
    if (parts.length) prompt += "**About me:** " + parts.join(" · ") + "\n\n";
  }

  // ── High-confidence facts ──
  const highConfFacts = (profile.facts || []).filter(f => (f.confidence || 0) >= 0.6);
  if (highConfFacts.length) {
    prompt += "**Other things to know:**\n";
    highConfFacts.slice(0, 10).forEach(f => { prompt += `- ${f.fact}\n`; });
    prompt += "\n";
  }

  prompt += "---\nPlease tailor your responses based on the above. Prioritize matching my preferred interaction style.";

  return { prompt, tokenEstimate: Math.ceil(prompt.length / 4) };
}

// ─── Data Access ──────────────────────────────────────────────
async function getMemoryProfile() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.MEMORY_PROFILE]);
  return result[STORAGE_KEYS.MEMORY_PROFILE] || DEFAULT_MEMORY_PROFILE;
}

async function getStats() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.STATS, STORAGE_KEYS.RAW_BUFFER]);
  const stats = result[STORAGE_KEYS.STATS] || DEFAULT_STATS;
  stats.bufferSize = (result[STORAGE_KEYS.RAW_BUFFER] || []).length;
  return stats;
}

async function getSettings() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS]);
  return result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
}

async function saveSettings(newSettings) {
  const result = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS]);
  const current = result[STORAGE_KEYS.SETTINGS] || DEFAULT_SETTINGS;
  const merged = { ...current, ...newSettings };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  return { success: true, settings: merged };
}

async function getRawBuffer() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.RAW_BUFFER]);
  return result[STORAGE_KEYS.RAW_BUFFER] || [];
}

async function getUpdateInfo() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.UPDATE_INFO]);
  const info = result[STORAGE_KEYS.UPDATE_INFO] || null;
  // Always include current version so popup can display it
  return { ...(info || {}), currentVersion: CURRENT_VERSION };
}

async function exportProfile() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.MEMORY_PROFILE, STORAGE_KEYS.STATS]);
  return {
    profile: result[STORAGE_KEYS.MEMORY_PROFILE] || DEFAULT_MEMORY_PROFILE,
    stats: result[STORAGE_KEYS.STATS] || DEFAULT_STATS,
    exportedAt: Date.now(),
    version: "memorybridge-v1"
  };
}

async function importProfile(data) {
  if (data.version !== "memorybridge-v1") return { success: false, error: "Incompatible profile version" };
  if (data.profile) await chrome.storage.local.set({ [STORAGE_KEYS.MEMORY_PROFILE]: data.profile });
  return { success: true };
}

async function clearAllData() {
  await chrome.storage.local.set({
    [STORAGE_KEYS.MEMORY_PROFILE]: DEFAULT_MEMORY_PROFILE,
    [STORAGE_KEYS.RAW_BUFFER]: [],
    [STORAGE_KEYS.STATS]: DEFAULT_STATS,
    [STORAGE_KEYS.CONVERSATIONS]: {}
  });
  return { success: true };
}

function setBadgeCount(count) {
  if (count > 0) {
    chrome.action.setBadgeText({ text: String(count) });
    chrome.action.setBadgeBackgroundColor({ color: "#6B5CE7" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}
