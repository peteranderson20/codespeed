# codespeed

**codespeed** is a Visual Studio Code extension that monitors Python files in real time and provides diagnostics directly inside the editor. The extension is designed as a foundation for future AI-powered performance analysis, code-quality checks, and automated optimization suggestions.

Whenever a Python file is opened, edited, or saved, codespeed analyzes the document and updates the VS Code Problems panel using a custom DiagnosticCollection. The goal is to create a seamless, always-on analysis workflow that reacts instantly as the developer writes code.

## What It Does

- Automatically activates when any Python file is opened.
- Remains active as long as a Python tab exists, even if the user switches to another file.
- Monitors:
  - Opening Python files  
  - Editing Python files  
  - Saving Python files  
  - Python files already open at startup
- Publishes diagnostics through VS Code’s Problems panel and squiggles.
- Includes a fully automated test suite that validates:
  - Extension activation
  - Python-only file monitoring
  - Event handling for open/change/save events
  - Correct diagnostic registration

## Why It Exists

Existing AI coding tools often take a reactive, on-demand approach—running only when the user requests it. codespeed is designed for the opposite philosophy: continuous feedback. Instead of waiting for the user to click “Analyze,” the extension analyzes code automatically and updates the editor as the user types.

This architecture prepares the extension for upcoming AI-driven features such as:

- Real-time performance bottleneck detection  
- Code smell detection  
- Automatic suggestions for optimization  
- AI-guided refactoring tools  

## Requirements

- Node.js and npm  
- VS Code extension development environment  
- No external API dependencies yet (AI features will be optional and modular)

## Current Limitations

- Diagnostics are placeholders without real analysis logic.
- No throttling for extremely rapid edits.
- Multi-root workspace behavior needs more testing.
- Future features will require additional configuration and performance tuning.

## Release History

**0.0.1** — Initial extension structure, Python file monitoring, diagnostic integration  
**0.0.2** — Added automated tests for activation and event handling  
**0.1.0** (planned) — Implement first real analysis rule and improved diagnostics  

---

codespeed is designed to grow into an intelligent performance-and-quality tool built directly into the editor. This version establishes the tested, stable foundation on which the AI components will be built.
