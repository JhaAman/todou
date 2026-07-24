---
name: todou
description: Read and manage the user's tasks through the installed Todou production app. Use when the user asks about their task list, priorities, planning, or wants work captured, updated, moved, completed, reopened, or deleted.
---

# Todou

Use the `todou` MCP tools as the source of truth for the user's current task list.

- Read tasks when the user asks about their plans, priorities, or existing work.
- Create or change tasks only when the user asks or clearly authorizes the change.
- Never delete a task without explicit confirmation for that deletion.
- List or get a task before changing it when its ID is not already known.
- Prefer `quick_add` for natural-language capture and structured tools for precise changes.
- Briefly report what changed after a successful write.
- If Todou cannot be reached, explain that the production app must be installed and can be launched automatically by the MCP bridge.
