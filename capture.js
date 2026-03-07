/**
 * MemoryBridge — Content Script (capture.js)
 *
 * Runs on chatbot pages. Uses the provider registry (providers.js)
 * to detect the current AI, observe DOM for messages, extract text,
 * and inject memory context.
 *
 * providers.js must be loaded before this script.
 */

(() => {
  "use strict";

  // Verify providers.js loaded
  if (typeof PROVIDERS === "undefined" || typeof detectProvider === "undefined") {
    console.error("[MemoryBridge] providers.js not loaded — capture cannot start");
    return;
  }
  console.log("[MemoryBridge] capture.js loaded, providers available:", Object.keys(PROVIDERS).join(", "));

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

  function getElementPosition(el) {
    const rect = el.getBoundingClientRect();
    return el.offsetTop || rect.top;
  }

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ─── Custom Extraction: Claude ───────────────────────────────
  // Claude renders paragraphs as separate <p> tags grouped by role.
  function extractClaudeMessages() {
    const messages = [];
    const allParagraphs = document.querySelectorAll(
      'p.whitespace-pre-wrap, p.font-claude-response-body'
    );

    let currentRole = null;
    let currentTexts = [];

    for (const p of allParagraphs) {
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
        if (currentRole && currentTexts.length > 0) {
          messages.push({ role: currentRole, text: currentTexts.join('\n\n'), timestamp: Date.now() });
        }
        currentRole = role;
        currentTexts = [text];
      } else {
        currentTexts.push(text);
      }
    }

    if (currentRole && currentTexts.length > 0) {
      messages.push({ role: currentRole, text: currentTexts.join('\n\n'), timestamp: Date.now() });
    }

    return messages;
  }

  // ─── Custom extraction registry ──────────────────────────────
  const CUSTOM_EXTRACTORS = {
    claude: extractClaudeMessages,
  };

  // ─── Generic Message Extraction ──────────────────────────────
  function extractAllMessages() {
    if (!currentProvider) return [];

    // Use custom extractor if defined
    if (currentProvider.extraction === "custom" && CUSTOM_EXTRACTORS[currentProvider.key]) {
      return CUSTOM_EXTRACTORS[currentProvider.key]();
    }

    // Generic: find user + assistant elements, sort by DOM position
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

  // ─── Capture Pipeline ───────────────────────────────────────
  function checkForNewMessages() {
    if (!captureEnabled) return;

    const currentMessages = extractAllMessages();
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
        payload: { conversationId, provider: currentProvider.key, url: currentUrl }
      }).catch(() => {});
    }
  }

  // ─── DOM Observer ────────────────────────────────────────────
  function startObserving() {
    if (observer) observer.disconnect();

    const target = trySelectors(currentProvider.selectors.container) || document.body;

    observer = new MutationObserver(() => {
      clearTimeout(startObserving._debounce);
      startObserving._debounce = setTimeout(() => {
        checkForNewMessages();
        checkUrlChange();
      }, 800);
    });

    observer.observe(target, { childList: true, subtree: true, characterData: true });
    setTimeout(checkForNewMessages, 2000);
  }

  // ─── Injection Engine ───────────────────────────────────────
  // Data-driven injection based on provider.injection type.

  function injectMemoryContext(memoryText) {
    const prefix = `[Context from my MemoryBridge profile — this describes who I am and my preferences]\n\n${memoryText}\n\n---\n\nNow, here's what I need help with:\n\n`;

    if (!currentProvider) {
      console.warn("[MemoryBridge] No provider detected, can't inject");
      return;
    }

    const editor = trySelectors(currentProvider.selectors.inputField);
    if (!editor) {
      console.warn(`[MemoryBridge] Could not find input field for ${currentProvider.name}`);
      fallbackCopy(prefix);
      return;
    }

    let success = false;
    const method = currentProvider.injection;

    if (method === "execCommand") {
      success = injectExecCommand(editor, prefix);
    } else if (method === "reactHTML") {
      success = injectReactHTML(editor, prefix);
    } else if (method === "textarea") {
      success = injectTextarea(editor, prefix);
    } else if (method === "auto") {
      // Try methods in order of likelihood
      if (editor.tagName === "TEXTAREA" || editor.tagName === "INPUT") {
        success = injectTextarea(editor, prefix);
      } else if (editor.contentEditable === "true") {
        success = injectExecCommand(editor, prefix);
        if (!success) success = injectReactHTML(editor, prefix);
      }
    }

    if (!success) {
      fallbackCopy(prefix);
    } else {
      console.log(`[MemoryBridge] Injected into ${currentProvider.name}`);
    }
  }

  /** ProseMirror / standard contenteditable */
  function injectExecCommand(editor, text) {
    try {
      editor.focus();
      document.execCommand("selectAll");
      document.execCommand("delete");
      document.execCommand("insertText", false, text);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** React-managed contenteditable (ChatGPT, Lexical) */
  function injectReactHTML(editor, text) {
    try {
      editor.focus();

      const lines = text.split("\n");
      let html = "";
      for (const line of lines) {
        html += line.trim() === "" ? "<p><br></p>" : `<p>${escapeHtml(line)}</p>`;
      }
      editor.innerHTML = html;

      editor.dispatchEvent(new Event("focus", { bubbles: true }));
      editor.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true, cancelable: true, inputType: "insertText", data: text
      }));
      editor.dispatchEvent(new InputEvent("input", {
        bubbles: true, cancelable: false, inputType: "insertText", data: text
      }));

      // Try React fiber state update
      try {
        const key = Object.keys(editor).find(k =>
          k.startsWith("__reactFiber") || k.startsWith("__reactInternalInstance")
        );
        if (key) {
          let fiber = editor[key];
          while (fiber) {
            if (fiber.memoizedState?.queue) {
              editor.dispatchEvent(new Event("change", { bubbles: true }));
              break;
            }
            if (fiber.stateNode?.props?.onChange) {
              fiber.stateNode.props.onChange({ target: editor });
              break;
            }
            fiber = fiber.return;
          }
        }
      } catch (_) {}

      // Place cursor at end
      try {
        const range = document.createRange();
        const sel = window.getSelection();
        const lastNode = editor.lastElementChild || editor;
        range.selectNodeContents(lastNode);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);
      } catch (_) {}

      return true;
    } catch (_) {
      return false;
    }
  }

  /** Plain textarea / input */
  function injectTextarea(editor, text) {
    try {
      editor.focus();
      editor.value = text;
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Clipboard fallback */
  function fallbackCopy(text) {
    navigator.clipboard.writeText(text).then(() => {
      console.log("[MemoryBridge] Copied to clipboard — paste manually with Ctrl+V");
    }).catch(() => {});
  }

  // ─── Message Listener ──────────────────────────────────────
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

  // ─── Initialize ──────────────────────────────────────────────
  let initRetries = 0;
  const MAX_RETRIES = 5;
  const RETRY_INTERVAL = 3000;

  function init() {
    currentProvider = detectProvider(window.location.hostname);

    if (!currentProvider) {
      // Retry a few times for late-loading sidebars (e.g. Comet)
      if (initRetries < MAX_RETRIES) {
        initRetries++;
        setTimeout(init, RETRY_INTERVAL);
      }
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
