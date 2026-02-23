/**
 * MemoryBridge — Content Script (capture.js)
 * 
 * Runs on chatbot pages. Detects which provider we're on,
 * observes the DOM for new messages, extracts text, and
 * sends it to the background service worker for storage.
 */

(() => {
  "use strict";

  // ─── Provider Detection ──────────────────────────────────────
  const PROVIDERS = {
    chatgpt: {
      hostPatterns: ["chat.openai.com", "chatgpt.com"],
      name: "ChatGPT",
      selectors: {
        conversationContainer: [
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
        ]
      }
    },
    claude: {
      hostPatterns: ["claude.ai"],
      name: "Claude",
      // Claude uses custom extraction — see extractClaudeMessages()
      useCustomExtraction: true,
      selectors: {
        conversationContainer: [
          '[class*="conversation"]',
          'main',
          '[role="main"]'
        ],
        userMessage: [],
        assistantMessage: [],
        messageText: ['p']
      }
    },
    gemini: {
      hostPatterns: ["gemini.google.com"],
      name: "Gemini",
      selectors: {
        conversationContainer: [
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
        ]
      }
    }
  };

  // ─── State ───────────────────────────────────────────────────
  let currentProvider = null;
  let capturedMessages = [];
  let lastMessageCount = 0;
  let observer = null;
  let captureEnabled = true;
  let conversationId = generateConversationId();
  let capturedFingerprints = new Set();

  // ─── Utility ─────────────────────────────────────────────────
  function generateConversationId() {
    return `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  function detectProvider() {
    const host = window.location.hostname;
    for (const [key, provider] of Object.entries(PROVIDERS)) {
      if (provider.hostPatterns.some(h => host.includes(h))) {
        return { key, ...provider };
      }
    }
    return null;
  }

  function trySelectors(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const el = root.querySelector(sel);
        if (el) return el;
      } catch (_) {}
    }
    return null;
  }

  function trySelectorsAll(selectors, root = document) {
    for (const sel of selectors) {
      try {
        const els = root.querySelectorAll(sel);
        if (els.length > 0) return Array.from(els);
      } catch (_) {}
    }
    return [];
  }

  function extractTextContent(element) {
    if (!element) return "";
    const clone = element.cloneNode(true);
    clone.querySelectorAll("script, style, svg, button").forEach(el => el.remove());
    return clone.textContent.replace(/\s+/g, " ").trim();
  }

  function getMessageText(messageEl, provider) {
    const textEl = trySelectors(provider.selectors.messageText, messageEl);
    if (textEl) return extractTextContent(textEl);
    return extractTextContent(messageEl);
  }

  function fingerprint(text) {
    let hash = 0;
    const str = text.trim().substring(0, 200);
    for (let i = 0; i < str.length; i++) {
      const chr = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + chr;
      hash |= 0;
    }
    return hash.toString(36);
  }

  // ─── Claude-Specific Extraction ──────────────────────────────
  // Claude renders each paragraph as its own <p> tag:
  //   User messages:      <p class="whitespace-pre-wrap break-words">
  //   Assistant messages:  <p class="font-claude-response-body ...">
  // We group consecutive same-role <p> tags into single logical messages.
  function extractClaudeMessages() {
    const messages = [];

    const allParagraphs = document.querySelectorAll(
      'p.whitespace-pre-wrap, p.font-claude-response-body'
    );

    let currentRole = null;
    let currentTexts = [];

    for (const p of allParagraphs) {
      // Skip notification toasts, hidden elements, nav
      if (p.closest('[role="region"][aria-label*="Notification"]') ||
          p.closest('[hidden]') ||
          p.closest('nav') ||
          p.offsetParent === null) {
        continue;
      }

      const classes = p.className || '';
      let role;

      if (classes.includes('font-claude-response-body')) {
        role = 'assistant';
      } else if (classes.includes('whitespace-pre-wrap') && classes.includes('break-words')) {
        role = 'user';
      } else {
        continue;
      }

      const text = extractTextContent(p);
      if (!text || text.length < 2) continue;

      if (role !== currentRole) {
        // Flush previous group
        if (currentRole && currentTexts.length > 0) {
          messages.push({
            role: currentRole,
            text: currentTexts.join('\n\n'),
            timestamp: Date.now()
          });
        }
        currentRole = role;
        currentTexts = [text];
      } else {
        currentTexts.push(text);
      }
    }

    // Flush final group
    if (currentRole && currentTexts.length > 0) {
      messages.push({
        role: currentRole,
        text: currentTexts.join('\n\n'),
        timestamp: Date.now()
      });
    }

    return messages;
  }

  // ─── Message Extraction ──────────────────────────────────────
  function extractAllMessages() {
    if (!currentProvider) return [];

    if (currentProvider.useCustomExtraction && currentProvider.key === 'claude') {
      return extractClaudeMessages();
    }

    const userEls = trySelectorsAll(currentProvider.selectors.userMessage);
    const assistantEls = trySelectorsAll(currentProvider.selectors.assistantMessage);

    const allMessageEls = [];

    userEls.forEach(el => {
      allMessageEls.push({ element: el, role: "user", position: getElementPosition(el) });
    });

    assistantEls.forEach(el => {
      allMessageEls.push({ element: el, role: "assistant", position: getElementPosition(el) });
    });

    allMessageEls.sort((a, b) => a.position - b.position);

    return allMessageEls.map(({ element, role }) => {
      const text = getMessageText(element, currentProvider);
      if (!text || text.length < 2) return null;
      return { role, text, timestamp: Date.now() };
    }).filter(Boolean);
  }

  function getElementPosition(el) {
    const rect = el.getBoundingClientRect();
    return el.offsetTop || rect.top;
  }

  // ─── Capture Pipeline ───────────────────────────────────────
  function checkForNewMessages() {
    if (!captureEnabled) return;

    const currentMessages = extractAllMessages();

    // Use fingerprinting to detect truly new messages
    const newMessages = [];
    for (const msg of currentMessages) {
      const fp = fingerprint(msg.role + ':' + msg.text);
      if (!capturedFingerprints.has(fp)) {
        capturedFingerprints.add(fp);
        newMessages.push(msg);
      }
    }

    if (newMessages.length > 0) {
      newMessages.forEach(msg => {
        capturedMessages.push(msg);
        chrome.runtime.sendMessage({
          type: "NEW_MESSAGE",
          payload: {
            conversationId,
            provider: currentProvider.key,
            providerName: currentProvider.name,
            message: msg,
            url: window.location.href,
            pageTitle: document.title
          }
        }).catch(() => {});
      });

      lastMessageCount = currentMessages.length;
      updateBadge();
    }
  }

  function updateBadge() {
    chrome.runtime.sendMessage({
      type: "UPDATE_BADGE",
      payload: { count: capturedMessages.length }
    }).catch(() => {});
  }

  // ─── URL Change Detection (SPA navigation) ──────────────────
  let lastUrl = window.location.href;

  function checkUrlChange() {
    const currentUrl = window.location.href;
    if (currentUrl !== lastUrl) {
      lastUrl = currentUrl;
      conversationId = generateConversationId();
      capturedMessages = [];
      lastMessageCount = 0;
      capturedFingerprints.clear();

      chrome.runtime.sendMessage({
        type: "NEW_CONVERSATION",
        payload: {
          conversationId,
          provider: currentProvider.key,
          url: currentUrl
        }
      }).catch(() => {});
    }
  }

  // ─── DOM Observer ────────────────────────────────────────────
  function startObserving() {
    if (observer) observer.disconnect();

    const target = trySelectors(currentProvider.selectors.conversationContainer) || document.body;

    observer = new MutationObserver((mutations) => {
      clearTimeout(startObserving._debounce);
      startObserving._debounce = setTimeout(() => {
        checkForNewMessages();
        checkUrlChange();
      }, 800);
    });

    observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true
    });

    // Initial extraction
    setTimeout(checkForNewMessages, 2000);
  }

  // ─── Message Listener (from popup/background) ───────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case "GET_CAPTURE_STATUS":
        sendResponse({
          provider: currentProvider?.name || "Unknown",
          messageCount: capturedMessages.length,
          enabled: captureEnabled,
          conversationId
        });
        return true;

      case "TOGGLE_CAPTURE":
        captureEnabled = msg.payload.enabled;
        sendResponse({ enabled: captureEnabled });
        return true;

      case "EXTRACT_FULL_CONVERSATION":
        const messages = extractAllMessages();
        sendResponse({ messages, provider: currentProvider?.key });
        return true;

      case "INJECT_MEMORY":
        injectMemoryContext(msg.payload.memoryText);
        sendResponse({ success: true });
        return true;
    }
  });

  // ─── Memory Injection ───────────────────────────────────────
  function injectMemoryContext(memoryText) {
    const prefix = `[Context from my MemoryBridge profile — this describes who I am and my preferences]\n\n${memoryText}\n\n---\n\nNow, here's what I need help with:\n\n`;

    if (!currentProvider) {
      console.warn("[MemoryBridge] No provider detected, can't inject");
      return;
    }

    let success = false;

    if (currentProvider.key === "claude") {
      success = injectIntoClaude(prefix);
    } else if (currentProvider.key === "chatgpt") {
      success = injectIntoChatGPT(prefix);
    } else if (currentProvider.key === "gemini") {
      success = injectIntoGemini(prefix);
    }

    if (!success) {
      // Fallback: copy to clipboard
      navigator.clipboard.writeText(prefix).then(() => {
        console.log("[MemoryBridge] Copied to clipboard as fallback");
      }).catch(() => {});
    }
  }

  /**
   * Paste text into a contenteditable editor by simulating a clipboard paste.
   * This works with ProseMirror, Draft.js, Lexical, etc. because it goes
   * through the browser's native editing pipeline.
   */
  async function pasteIntoEditor(editor, text) {
    editor.focus();

    // Try the clipboard API approach first (most reliable)
    try {
      // Save current clipboard
      const prevClipboard = await navigator.clipboard.readText().catch(() => "");

      // Write our text to clipboard
      await navigator.clipboard.writeText(text);

      // Execute paste command
      document.execCommand("paste");

      // Restore previous clipboard after a short delay
      setTimeout(() => {
        navigator.clipboard.writeText(prevClipboard).catch(() => {});
      }, 500);

      return true;
    } catch (_) {}

    // Fallback: synthetic paste event with DataTransfer
    try {
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      const pasteEvent = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt
      });
      editor.dispatchEvent(pasteEvent);

      // If the editor didn't handle the paste event, manually insert
      if (!pasteEvent.defaultPrevented) {
        document.execCommand("insertText", false, text);
      }
      return true;
    } catch (_) {}

    // Last resort: insertText command (works in many editors)
    try {
      document.execCommand("insertText", false, text);
      return true;
    } catch (_) {}

    return false;
  }

  function injectIntoClaude(text) {
    const editor = document.querySelector(
      'div.ProseMirror[contenteditable="true"], ' +
      '[contenteditable="true"].ProseMirror, ' +
      '[contenteditable="true"][data-placeholder]'
    );

    if (!editor) {
      console.warn("[MemoryBridge] Could not find Claude's editor");
      return false;
    }

    // Clear existing content first
    editor.focus();
    document.execCommand("selectAll");
    document.execCommand("delete");

    pasteIntoEditor(editor, text);
    console.log("[MemoryBridge] Injected into Claude editor");
    return true;
  }

  function injectIntoChatGPT(text) {
    const editor = document.querySelector(
      '#prompt-textarea[contenteditable="true"], ' +
      '#prompt-textarea, ' +
      '[contenteditable="true"][data-id="root"]'
    );

    if (!editor) {
      console.warn("[MemoryBridge] Could not find ChatGPT's input");
      return false;
    }

    editor.focus();

    if (editor.tagName === "TEXTAREA") {
      // Old textarea style (unlikely now but just in case)
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(editor, text);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      // Contenteditable — clear and paste
      document.execCommand("selectAll");
      document.execCommand("delete");
      pasteIntoEditor(editor, text);
    }

    console.log("[MemoryBridge] Injected into ChatGPT editor");
    return true;
  }

  function injectIntoGemini(text) {
    const editor = document.querySelector(
      'rich-textarea .ql-editor, ' +
      'rich-textarea [contenteditable="true"], ' +
      '.text-input-field [contenteditable="true"], ' +
      'textarea'
    );

    if (!editor) {
      console.warn("[MemoryBridge] Could not find Gemini's input");
      return false;
    }

    editor.focus();

    if (editor.tagName === "TEXTAREA") {
      editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll");
      document.execCommand("delete");
      pasteIntoEditor(editor, text);
    }

    console.log("[MemoryBridge] Injected into Gemini editor");
    return true;
  }

  // ─── Initialize ──────────────────────────────────────────────
  function init() {
    currentProvider = detectProvider();
    if (!currentProvider) {
      console.log("[MemoryBridge] No supported provider detected on this page.");
      return;
    }

    console.log(`[MemoryBridge] Detected provider: ${currentProvider.name}`);

    chrome.storage.local.get(["captureEnabled"], (result) => {
      captureEnabled = result.captureEnabled !== false;
      startObserving();
    });

    chrome.runtime.sendMessage({
      type: "CONTENT_SCRIPT_READY",
      payload: {
        provider: currentProvider.key,
        providerName: currentProvider.name,
        url: window.location.href
      }
    }).catch(() => {});
  }

  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", () => setTimeout(init, 1500));
  }

})();
