# Orbit Focus Guard (Chrome Extension)

A no-build Chrome extension (Manifest V3) that includes:
- Pomodoro focus/break timer
- Task tracking tied directly to focus timers
- manual `X / goal` hour tracking (default goal: 64h)
- Site blocker using Chrome declarative network request rules
- Break-time unblocking for selected domains

## Install (no compiling)
1. Download or clone this folder.
2. In Chrome, open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select this project folder (`Orbit-extension`).

## Notes on blocker limits
Chrome does not allow extensions to be uninstall-proof.
No extension can guarantee a truly non-bypassable blocker against a device owner/admin.

This extension still applies robust blocking rules via `declarativeNetRequest` and supports:
- Focus-only blocking while timer is running
- Always-on blocking
- Break-only unblocking for specific sites

## Usage
- Open the extension popup.
- Add a task.
- Select the task and press Start.
- Focus sessions are added to the selected task when a full focus interval completes.
- Update `X / goal` manually in the popup (it does not auto-track).
- Open Options for blocker domain list, mode, and break-time unblock list.
