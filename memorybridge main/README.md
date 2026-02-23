# MemoryBridge

**Your portable AI memory.** Capture conversations across ChatGPT, Claude, and Gemini — distill them into a personal context profile — carry your memory to any AI, anywhere.

## Installation

1. Download and unzip this extension
2. Open Chrome → `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** → select the unzipped folder
5. Pin the MemoryBridge icon in your toolbar

## Setup

1. Click the MemoryBridge icon → **Settings** tab
2. Choose provider (Anthropic or OpenAI)
3. Paste your API key
4. Hit **Save Settings**

## Usage

- Chat normally on ChatGPT, Claude, or Gemini — messages are captured automatically
- Open the popup → **Capture** tab to see buffered messages
- Click **Distill Now** on the Memory tab to process captured messages into a profile
- Go to **Use It** tab to copy your context prompt for any new AI conversation

## Version 1.1.0

- Fixed Claude paragraph splitting (messages now grouped properly)
- Added fingerprint-based deduplication (no more duplicate entries)
- Buffer-level dedup safety net in background worker
