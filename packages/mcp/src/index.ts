#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { parseQuickTask } from "./natural-language";
import {
  TodouLocalClient,
  type LocalResult,
} from "./socket-client";

const local = new TodouLocalClient();
const server = new McpServer({ name: "todou", version: "0.1.0" });

const taskId = z.string().uuid().describe("The Todou task UUID.");
const bucket = z.enum(["today", "inbox"]);
const priority = z.enum(["high", "low"]);
const area = z.enum(["personal", "work"]);
const dueDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const estimateMinutes = z.number().int().min(1).max(1440);

const taskClocks = z.object({
  title: z.string(),
  description: z.string(),
  schedule: z.string(),
  priority: z.string(),
  area: z.string(),
  estimate: z.string(),
  order: z.string(),
  completion: z.string(),
  deletion: z.string(),
});

const task = z.object({
  id: taskId,
  title: z.string(),
  description: z.string(),
  bucket,
  priority,
  area,
  dueDate: dueDate.nullable(),
  estimateMinutes: estimateMinutes.nullable(),
  orderKey: z.string(),
  completedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  clocks: taskClocks,
});

const exportedTask = task.omit({ clocks: true, deletedAt: true });
const exportSnapshot = z.object({
  schemaVersion: z.number().int().positive(),
  exportedAt: z.string(),
  tasks: z.array(exportedTask),
  preferences: z.record(z.string(), z.unknown()),
});

type Task = z.infer<typeof task>;
type ExportSnapshot = z.infer<typeof exportSnapshot>;

function envelopeSchema<T extends z.ZodType>(result: T) {
  return {
    result,
    revision: z.number().int().nonnegative(),
  };
}

function toolResult<T>(value: LocalResult<T>) {
  const structuredContent = {
    result: value.result,
    revision: value.revision,
  };
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(structuredContent, null, 2),
      },
    ],
    structuredContent,
  };
}

server.registerTool(
  "list_tasks",
  {
    title: "List Todou tasks",
    description:
      "List the latest local Todou state. Results may still be waiting to sync to another Mac.",
    inputSchema: {
      bucket: bucket.optional(),
      priority: priority.optional(),
      area: area.optional(),
      completed: z.boolean().optional(),
      dueDate: dueDate.optional(),
      query: z.string().trim().max(500).optional(),
    },
    outputSchema: envelopeSchema(z.array(task)),
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ query, ...filters }) =>
    toolResult(
      await local.call<Task[]>("listTasks", {
        ...filters,
        ...(query === undefined ? {} : { text: query }),
      }),
    ),
);

server.registerTool(
  "get_task",
  {
    title: "Get a Todou task",
    description: "Get one task from Todou's local cache.",
    inputSchema: { id: taskId },
    outputSchema: envelopeSchema(task),
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async ({ id }) => toolResult(await local.call<Task>("getTask", { id })),
);

server.registerTool(
  "create_task",
  {
    title: "Create a Todou task",
    description:
      "Create a task locally and queue it for background synchronization.",
    inputSchema: {
      id: taskId.optional(),
      title: z.string().trim().min(1).max(500),
      bucket: bucket.default("inbox"),
      priority: priority.default("low"),
      area: area.default("personal"),
      dueDate: dueDate.nullable().optional(),
      estimateMinutes: estimateMinutes.nullable().optional(),
    },
    outputSchema: envelopeSchema(task),
  },
  async (input) =>
    toolResult(await local.call<Task>("createTask", input)),
);

server.registerTool(
  "quick_add",
  {
    title: "Quick-add a Todou task",
    description:
      "Create a task from natural language such as 'Review proposal tomorrow 25m !high /work', with optional structured overrides.",
    inputSchema: {
      text: z.string().trim().min(1).max(1000),
      bucket: bucket.optional(),
      priority: priority.optional(),
      area: area.optional(),
      dueDate: dueDate.nullable().optional(),
      estimateMinutes: estimateMinutes.nullable().optional(),
    },
    outputSchema: envelopeSchema(task),
  },
  async ({ text, ...overrides }) => {
    const parsed = parseQuickTask(text);
    const input = { ...parsed, ...overrides };
    input.bucket ??= "inbox";
    input.priority ??= "low";
    input.area ??= "personal";
    return toolResult(
      await local.call<Task>("createTask", input),
    );
  },
);

server.registerTool(
  "update_task",
  {
    title: "Update a Todou task",
    description: "Update editable fields on an existing local task.",
    inputSchema: {
      id: taskId,
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().trim().max(10_000).optional(),
      priority: priority.optional(),
      area: area.optional(),
      dueDate: dueDate.nullable().optional(),
      estimateMinutes: estimateMinutes.nullable().optional(),
    },
    outputSchema: envelopeSchema(task),
    annotations: { idempotentHint: true },
  },
  async ({ id, ...patch }) =>
    toolResult(await local.call<Task>("updateTask", { id, patch })),
);

server.registerTool(
  "move_task",
  {
    title: "Move a Todou task",
    description:
      "Move a task between Today and Inbox. Moving to Inbox clears its due date.",
    inputSchema: { id: taskId, bucket },
    outputSchema: envelopeSchema(task),
    annotations: { idempotentHint: true },
  },
  async (input) =>
    toolResult(await local.call<Task>("moveTask", input)),
);

server.registerTool(
  "reorder_task",
  {
    title: "Reorder a Todou task",
    description:
      "Place a task between adjacent task IDs in the same bucket and priority tier.",
    inputSchema: {
      id: taskId,
      beforeId: taskId.optional(),
      afterId: taskId.optional(),
    },
    outputSchema: envelopeSchema(z.array(task)),
  },
  async (input) =>
    toolResult(await local.call<Task[]>("reorderTask", input)),
);

server.registerTool(
  "complete_task",
  {
    title: "Complete a Todou task",
    description: "Complete a task and move it into Logbook.",
    inputSchema: { id: taskId },
    outputSchema: envelopeSchema(task),
  },
  async ({ id }) =>
    toolResult(await local.call<Task>("completeTask", { id })),
);

server.registerTool(
  "reopen_task",
  {
    title: "Reopen a Todou task",
    description: "Restore a completed task from Logbook.",
    inputSchema: { id: taskId },
    outputSchema: envelopeSchema(task),
  },
  async ({ id }) =>
    toolResult(await local.call<Task>("restoreTask", { id })),
);

server.registerTool(
  "delete_task",
  {
    title: "Delete a Todou task",
    description: "Delete a task. Todou exposes no trash or recovery MCP tool.",
    inputSchema: { id: taskId },
    outputSchema: envelopeSchema(z.null()),
    annotations: { destructiveHint: true },
  },
  async ({ id }) =>
    toolResult(await local.call<null>("deleteTask", { id })),
);

server.registerTool(
  "export_tasks",
  {
    title: "Export Todou",
    description:
      "Return Todou's human-readable local JSON export without credentials or sync internals.",
    inputSchema: {},
    outputSchema: envelopeSchema(exportSnapshot),
    annotations: { readOnlyHint: true, idempotentHint: true },
  },
  async () =>
    toolResult(await local.call<ExportSnapshot>("exportTasks")),
);

const transport = new StdioServerTransport();
await server.connect(transport);
