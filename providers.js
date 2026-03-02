/**
 * MemoryBridge — Provider Registry (providers.js)
 *
 * Each provider is a self-contained config object.
 * To add a new AI chatbot, just add an entry here and
 * update manifest.json content_scripts.matches.
 *
 * Fields:
 *   hostPatterns   — array of hostname substrings to match
 *   name           — display name
 *   color          — hex color for UI badges
 *   extraction     — "generic" (use selectors) or "custom" (needs custom fn in capture.js)
 *   injection      — "execCommand" (ProseMirror-style), "reactHTML" (React contenteditable),
 *                    "textarea" (plain textarea/input), or "auto" (tries execCommand then textarea)
 *   selectors:
 *     container        — conversation scroll container (for MutationObserver)
 *     userMessage      — elements wrapping user messages
 *     assistantMessage — elements wrapping assistant messages
 *     messageText      — inner element containing the actual text
 *     inputField       — the chat input element for injection
 */

const PROVIDERS = {

  chatgpt: {
    hostPatterns: ["chat.openai.com", "chatgpt.com"],
    name: "ChatGPT",
    color: "#10A37F",
    extraction: "generic",
    injection: "reactHTML",
    selectors: {
      container: [
        'main [class*="react-scroll-to-bottom"]',
        'main',
        '[role="presentation"]'
      ],
      userMessage: [
        '[data-message-author-role="user"]',
        '[class*="user-turn"]',
        '.text-base:has(.whitespace-pre-wrap)'
      ],
      assistantMessage: [
        '[data-message-author-role="assistant"]',
        '[class*="agent-turn"]',
        '.markdown'
      ],
      messageText: [
        '.whitespace-pre-wrap',
        '.markdown',
        'p'
      ],
      inputField: [
        '#prompt-textarea[contenteditable="true"]',
        '#prompt-textarea',
        '[contenteditable="true"][data-id="root"]'
      ]
    }
  },

  claude: {
    hostPatterns: ["claude.ai"],
    name: "Claude",
    color: "#D97706",
    extraction: "custom",       // uses extractClaudeMessages()
    injection: "execCommand",
    selectors: {
      container: [
        '[class*="conversation"]',
        'main',
        '[role="main"]'
      ],
      userMessage: [],
      assistantMessage: [],
      messageText: ['p'],
      inputField: [
        'div.ProseMirror[contenteditable="true"]',
        '[contenteditable="true"].ProseMirror',
        '[contenteditable="true"][data-placeholder]'
      ]
    }
  },

  gemini: {
    hostPatterns: ["gemini.google.com"],
    name: "Gemini",
    color: "#4285F4",
    extraction: "generic",
    injection: "auto",
    selectors: {
      container: [
        'chat-window',
        'main',
        '.conversation-container'
      ],
      userMessage: [
        'user-query',
        '.query-content',
        '[class*="user-query"]',
        '.request-content'
      ],
      assistantMessage: [
        'model-response',
        '.response-content',
        '[class*="model-response"]',
        'message-content'
      ],
      messageText: [
        '.markdown-main-panel',
        '.response-content',
        'p'
      ],
      inputField: [
        'rich-textarea .ql-editor',
        'rich-textarea [contenteditable="true"]',
        '.text-input-field [contenteditable="true"]',
        'textarea'
      ]
    }
  },

  perplexity: {
    hostPatterns: ["perplexity.ai"],
    name: "Perplexity",
    color: "#22B8CD",
    extraction: "generic",
    injection: "auto",
    selectors: {
      container: [
        '[class*="ConversationMessages"]',
        'main',
        '[class*="thread"]'
      ],
      userMessage: [
        '[class*="UserMessage"]',
        '[class*="query-text"]',
        '[data-testid*="user"]'
      ],
      assistantMessage: [
        '[class*="AnswerMessage"]',
        '[class*="prose"]',
        '[class*="answer-text"]',
        '[data-testid*="answer"]'
      ],
      messageText: [
        '.prose',
        '[class*="markdown"]',
        'p'
      ],
      inputField: [
        'textarea[placeholder*="Ask"]',
        'textarea[placeholder*="ask"]',
        'textarea',
        '[contenteditable="true"]'
      ]
    }
  },

  comet: {
    hostPatterns: ["comet"],     // Comet is its own browser — matches any comet-internal pages
    name: "Comet",
    color: "#22B8CD",           // Same brand as Perplexity
    extraction: "generic",
    injection: "auto",
    // NOTE: Comet's sidebar assistant selectors need verification.
    // Install MemoryBridge in Comet, inspect the sidebar, and update these.
    selectors: {
      container: [
        '[class*="sidebar"]',
        '[class*="assistant"]',
        '[class*="chat-panel"]',
        '[class*="conversation"]',
        'main'
      ],
      userMessage: [
        '[class*="UserMessage"]',
        '[class*="user-message"]',
        '[data-role="user"]',
        '[class*="query"]'
      ],
      assistantMessage: [
        '[class*="AssistantMessage"]',
        '[class*="assistant-message"]',
        '[data-role="assistant"]',
        '[class*="answer"]',
        '[class*="prose"]'
      ],
      messageText: [
        '.prose',
        '[class*="markdown"]',
        '[class*="message-content"]',
        'p'
      ],
      inputField: [
        'textarea[placeholder*="Ask"]',
        'textarea',
        '[contenteditable="true"]'
      ]
    }
  },

  copilot: {
    hostPatterns: ["copilot.microsoft.com"],
    name: "Copilot",
    color: "#7F54B3",
    extraction: "generic",
    injection: "auto",
    selectors: {
      container: [
        '[class*="conversation"]',
        '#app',
        'main'
      ],
      userMessage: [
        '[data-content="user-message"]',
        '[class*="user-message"]',
        '[class*="UserMessage"]'
      ],
      assistantMessage: [
        '[data-content="ai-message"]',
        '[class*="ai-message"]',
        '[class*="AssistantMessage"]',
        '[class*="response"]'
      ],
      messageText: [
        '[class*="ac-textBlock"]',
        '[class*="markdown"]',
        '.prose',
        'p'
      ],
      inputField: [
        'textarea#userInput',
        '#searchbox',
        'textarea',
        '[contenteditable="true"]'
      ]
    }
  },

  grok: {
    hostPatterns: ["grok.com", "x.com/i/grok"],
    name: "Grok",
    color: "#1D9BF0",
    extraction: "generic",
    injection: "auto",
    selectors: {
      container: [
        '[class*="conversation"]',
        'main',
        '[role="main"]'
      ],
      userMessage: [
        '[data-testid*="user"]',
        '[class*="user-message"]',
        '[class*="UserMessage"]'
      ],
      assistantMessage: [
        '[data-testid*="assistant"]',
        '[class*="assistant-message"]',
        '[class*="AssistantMessage"]',
        '[class*="response"]'
      ],
      messageText: [
        '[class*="markdown"]',
        '.prose',
        'p'
      ],
      inputField: [
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]'
      ]
    }
  },

  deepseek: {
    hostPatterns: ["chat.deepseek.com"],
    name: "DeepSeek",
    color: "#4D6BFE",
    extraction: "generic",
    injection: "auto",
    selectors: {
      container: [
        '[class*="conversation"]',
        '#chat-container',
        'main'
      ],
      userMessage: [
        '[class*="user-message"]',
        '[class*="self-end"]',
        '[data-role="user"]'
      ],
      assistantMessage: [
        '[class*="assistant-message"]',
        '[class*="self-start"]',
        '[data-role="assistant"]',
        '[class*="markdown"]'
      ],
      messageText: [
        '[class*="markdown"]',
        '.prose',
        'p'
      ],
      inputField: [
        'textarea#chat-input',
        'textarea',
        '[contenteditable="true"]'
      ]
    }
  },

  poe: {
    hostPatterns: ["poe.com"],
    name: "Poe",
    color: "#6C5CE7",
    extraction: "generic",
    injection: "auto",
    selectors: {
      container: [
        '[class*="ChatMessages"]',
        '[class*="chat-messages"]',
        'main'
      ],
      userMessage: [
        '[class*="HumanMessage"]',
        '[class*="human-message"]'
      ],
      assistantMessage: [
        '[class*="BotMessage"]',
        '[class*="bot-message"]',
        '[class*="response"]'
      ],
      messageText: [
        '[class*="Markdown"]',
        '[class*="markdown"]',
        '.prose',
        'p'
      ],
      inputField: [
        'textarea[class*="TextArea"]',
        'textarea',
        '[contenteditable="true"]'
      ]
    }
  }

};

// ─── Helpers ────────────────────────────────────────────────────

/** Get all hostnames that content scripts need to match */
function getAllContentScriptMatches() {
  const matches = new Set();
  for (const p of Object.values(PROVIDERS)) {
    for (const h of p.hostPatterns) {
      matches.add(`https://${h}/*`);
      // Also add www variant if not already there
      if (!h.startsWith("www.")) {
        matches.add(`https://www.${h}/*`);
      }
    }
  }
  return [...matches];
}

/** Look up provider by current hostname */
function detectProvider(hostname) {
  for (const [key, provider] of Object.entries(PROVIDERS)) {
    if (provider.hostPatterns.some(h => hostname.includes(h))) {
      return { key, ...provider };
    }
  }
  return null;
}

/** Get provider badge CSS color */
function getProviderColor(providerKey) {
  return PROVIDERS[providerKey]?.color || "#6B7280";
}

// Make available to other scripts
if (typeof module !== "undefined") {
  module.exports = { PROVIDERS, detectProvider, getProviderColor, getAllContentScriptMatches };
}
