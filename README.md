# MemoryBridge

**One profile, every AI.** MemoryBridge captures your conversations across AI chatbots, distills them into a portable preference profile, and injects that context wherever you go next. No API keys required.

## Supported Providers

| Provider | Capture | Inject | Notes |
|----------|---------|--------|-------|
| ChatGPT | ✅ | ✅ | React/Lexical injection |
| Claude | ✅ | ✅ | ProseMirror injection |
| Gemini | ✅ | ✅ | |
| Perplexity | ✅ | ✅ | Shared renderer with Comet |
| Comet (by Perplexity) | 🔧 | 🔧 | Sidebar overlay — WIP |
| Copilot | 🔧 | 🔧 | Selectors need verification |
| Grok | 🔧 | 🔧 | Selectors need verification |
| DeepSeek | 🔧 | 🔧 | Selectors need verification |
| Poe | 🔧 | 🔧 | Selectors need verification |

✅ = tested and working · 🔧 = provider config added, selectors may need tuning

## Installation

1. Download the latest release from [Releases](https://github.com/leeyaoming111-rgb/memorybridge/releases)
2. Unzip to a folder on your computer
3. Open Chrome (or any Chromium browser) → `chrome://extensions/`
4. Enable **Developer mode** (top-right toggle)
5. Click **Load unpacked** → select the unzipped `memorybridge` folder
6. The MemoryBridge icon appears in your toolbar

## How It Works

1. **Chat normally** — visit any supported AI chatbot. MemoryBridge silently captures messages in the background.
2. **Distill** — click the extension icon → "Distill Now". It analyzes your conversations and builds a preference profile.
3. **Inject** — on any chatbot page, click "Inject to Page" to pre-fill the chat input with your profile context.

## What Gets Captured

MemoryBridge focuses on interaction preferences, not biographical data:

- **Learning style** — how you prefer to receive explanations
- **Response format** — code-first vs. explanation-first, conciseness, structure
- **Tone** — formal, casual, direct, etc.
- **Pet peeves** — things you dislike in AI responses
- **Expertise & tools** — so the AI calibrates depth and suggests relevant solutions

## Settings

Open the extension popup → **Settings** tab.

**Distillation provider** — how MemoryBridge processes your conversations:
- `Claude Session` or `ChatGPT Session` — uses your existing browser login (no API key needed)
- `Anthropic API` or `OpenAI API` — uses your own API key

**Auto-capture** — captures conversations as you chat (on by default).

**Auto-distill** — automatically distills when enough messages are buffered.

**Updates** — checks for new versions automatically. All past releases viewable under Settings → Updates.

## Updating

When a new version is available, a banner appears in the extension popup.

1. Download the new zip from the banner or Settings → Updates
2. Replace the files in your extension folder
3. Go to `chrome://extensions` and click the refresh icon on MemoryBridge

Your memory profile is never lost during updates.

## Architecture

```
providers.js    — Provider registry (selectors, injection methods, detection)
capture.js      — Content script (message extraction, DOM observation, injection engine)
background.js   — Service worker (storage, distillation, update checking)
popup.html/js   — Extension popup UI (Marble design system)
```

### Adding a New Provider

Edit `providers.js` and add an entry:

```javascript
myProvider: {
  hostPatterns: ["myprovider.com"],     // hostname matching
  name: "MyProvider",
  color: "#FF6600",
  extraction: "generic",                // or "custom" for non-standard DOM
  injection: "auto",                    // "execCommand", "reactHTML", "textarea", or "auto"
  selectors: {
    container: ['main'],                // MutationObserver target
    userMessage: ['[data-role="user"]'],
    assistantMessage: ['[data-role="assistant"]'],
    messageText: ['p'],
    inputField: ['textarea']
  }
}
```

Then add the hostname to `manifest.json` → `content_scripts.matches`.

For sidebar overlays (like Comet), use `domDetectors` instead of `hostPatterns`:

```javascript
domDetectors: ['#some-unique-element'],  // detected by DOM presence
hostPatterns: [],
```

## Privacy

- All data stored locally in Chrome's extension storage
- No external servers, no tracking, no accounts
- Session distillation creates a temporary conversation that is immediately discarded
- Export, import, or delete all data from Settings

## Version History

- **0.9.x** — Provider registry, added Perplexity/Comet/Copilot/Grok/DeepSeek/Poe, DOM-based sidebar detection
- **0.8.0** — Marble redesign (white theme, orange accent, node logo, Inter font)
- **0.7.2** — ChatGPT injection fix, release history viewer, getting started guide
- **0.7.0** — Update system with GitHub releases integration
- **0.5.0** — Session-based distillation (no API key needed)
- **0.2.0** — v2 schema: interaction preferences over biographical data
- **0.1.0** — Initial release with ChatGPT, Claude, Gemini capture

## License

MIT
