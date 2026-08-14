import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickEntry } from "./QuickEntry";
import { taskClient } from "../../lib/taskClient";
import { taskDescriptionMaxLength, type Task } from "../../lib/types";

function pasteQuickEntry(value: string, start?: number, end = start) {
  const input = screen.getByLabelText("New task") as HTMLInputElement;
  const selectionStart = start ?? input.value.length;
  input.setSelectionRange(selectionStart, end ?? selectionStart);
  const defaultAllowed = fireEvent.paste(input, {
    clipboardData: { getData: () => value },
  });
  if (defaultAllowed) fireEvent.change(input, { target: { value } });
}

async function saveQuickEntry(buttonName = /Add to Inbox/i) {
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
}

function savedTask(title: string): Task | undefined {
  const tasks = JSON.parse(localStorage.getItem("todou.browser.tasks.v1") ?? "[]") as Task[];
  return tasks.find((task) => task.title === title);
}

describe("quick entry", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("previews parsed metadata and saves the cleaned task", async () => {
    render(<QuickEntry />);
    fireEvent.change(screen.getByLabelText("New task"), {
      target: { value: "Review proposal tomorrow 25m !high /work" },
    });

    expect(screen.getByText("Tomorrow")).toBeInTheDocument();
    expect(screen.getByText("25m")).toBeInTheDocument();
    expect(screen.getAllByText("High").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: /Add to Inbox/i }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const tasks = JSON.parse(localStorage.getItem("todou.browser.tasks.v1") ?? "[]") as Task[];
    const saved = tasks.find(({ title }) => title === "Review proposal");
    expect(saved).toMatchObject({
      title: "Review proposal",
      bucket: "inbox",
      priority: "high",
      area: "work",
      estimateMinutes: 25,
    });
  });

  it("saves an explicit Today choice with today's due date", async () => {
    render(<QuickEntry />);
    fireEvent.change(screen.getByLabelText("New task"), {
      target: { value: "Call Jordan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Today list" }));
    fireEvent.click(screen.getByRole("button", { name: /Add to Today/i }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const tasks = JSON.parse(localStorage.getItem("todou.browser.tasks.v1") ?? "[]") as Task[];
    const saved = tasks.find(({ title }) => title === "Call Jordan");
    const now = new Date();
    const today = `${now.getFullYear()}-${`${now.getMonth() + 1}`.padStart(2, "0")}-${`${now.getDate()}`.padStart(2, "0")}`;
    expect(saved).toMatchObject({ bucket: "today", dueDate: today });
  });

  it("keeps a future-dated task in Inbox after the Today control was selected", async () => {
    render(<QuickEntry />);
    fireEvent.change(screen.getByLabelText("New task"), {
      target: { value: "Call Jordan" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Today list" }));
    fireEvent.change(screen.getByLabelText("Due date"), { target: { value: "2099-01-01" } });

    fireEvent.click(screen.getByRole("button", { name: /Add to Inbox/i }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const tasks = JSON.parse(localStorage.getItem("todou.browser.tasks.v1") ?? "[]") as Task[];
    const saved = tasks.find(({ title }) => title === "Call Jordan");
    expect(saved).toMatchObject({ bucket: "inbox", dueDate: "2099-01-01" });
  });

  it("moves a pasted URL from the visible title into the task description", async () => {
    render(<QuickEntry />);

    pasteQuickEntry("Review proposal https://example.com/proposal");

    expect(screen.getByLabelText("New task")).toHaveValue("Review proposal");
    await saveQuickEntry();
    expect(savedTask("Review proposal")).toMatchObject({
      title: "Review proposal",
      description: "https://example.com/proposal",
    });
  });

  it("stores multiple pasted URLs one per line in their original order", async () => {
    render(<QuickEntry />);

    pasteQuickEntry(
      "Compare https://first.example/a then share https://second.example/b tomorrow",
    );

    expect(screen.getByLabelText("New task")).toHaveValue("Compare then share tomorrow");
    await saveQuickEntry();
    expect(savedTask("Compare then share")?.description).toBe(
      "https://first.example/a\nhttps://second.example/b",
    );
  });

  it("uses the hostname as the title when the paste contains only a URL", async () => {
    render(<QuickEntry />);

    pasteQuickEntry("https://docs.example.com/guide/start");

    expect(screen.getByLabelText("New task")).toHaveValue("docs.example.com");
    await saveQuickEntry();
    expect(savedTask("docs.example.com")).toMatchObject({
      title: "docs.example.com",
      description: "https://docs.example.com/guide/start",
    });
  });

  it("does not add a hostname fallback when the draft already has a title", async () => {
    render(<QuickEntry />);
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Read this" } });

    pasteQuickEntry("https://docs.example.com/guide");

    expect(screen.getByLabelText("New task")).toHaveValue("Read this");
    await saveQuickEntry();
    expect(savedTask("Read this")?.description).toBe("https://docs.example.com/guide");
  });

  it("preserves a valid URL that ends in a parenthesis", async () => {
    render(<QuickEntry />);

    pasteQuickEntry("Read https://en.wikipedia.org/wiki/Foo_(bar)");

    expect(screen.getByLabelText("New task")).toHaveValue("Read");
    await saveQuickEntry();
    expect(savedTask("Read")?.description).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
  });

  it("keeps sentence punctuation out of the saved URL", async () => {
    render(<QuickEntry />);

    pasteQuickEntry("Review https://example.com/proposal.");

    expect(screen.getByLabelText("New task")).toHaveValue("Review.");
    await saveQuickEntry();
    expect(savedTask("Review")?.description).toBe("https://example.com/proposal");
  });

  it("rejects oversized pasted-link descriptions before creating a task", async () => {
    render(<QuickEntry />);
    pasteQuickEntry(`Review https://example.com/${"a".repeat(taskDescriptionMaxLength)}`);

    fireEvent.click(screen.getByRole("button", { name: /Add to Inbox/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Too many links");
    expect(savedTask("Review")).toBeUndefined();
  });

  it("retries a failed description update without creating a duplicate task", async () => {
    vi.spyOn(taskClient, "updateTask").mockRejectedValueOnce(new Error("Temporary failure"));
    render(<QuickEntry />);
    pasteQuickEntry("Review https://example.com/proposal");

    fireEvent.click(screen.getByRole("button", { name: /Add to Inbox/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn’t save");
    expect(screen.getByLabelText("New task")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Add to Inbox/i }));

    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    const tasks = JSON.parse(localStorage.getItem("todou.browser.tasks.v1") ?? "[]") as Task[];
    expect(tasks.filter(({ title }) => title === "Review")).toHaveLength(1);
    expect(savedTask("Review")?.description).toBe("https://example.com/proposal");
  });

  it("keeps no-URL paste behavior and natural-language parsing unchanged", async () => {
    render(<QuickEntry />);

    pasteQuickEntry("Review proposal tomorrow 25m !high /work");

    expect(screen.getByLabelText("New task")).toHaveValue(
      "Review proposal tomorrow 25m !high /work",
    );
    await saveQuickEntry();
    expect(savedTask("Review proposal")).toMatchObject({
      description: "",
      priority: "high",
      area: "work",
      estimateMinutes: 25,
    });
  });

  it("clears extracted links when Quick Entry is closed", async () => {
    render(<QuickEntry />);
    pasteQuickEntry("First task https://example.com/first");

    fireEvent.keyDown(screen.getByLabelText("New task"), { key: "Escape" });
    expect(screen.getByLabelText("New task")).toHaveValue("");
    fireEvent.change(screen.getByLabelText("New task"), { target: { value: "Second task" } });

    await saveQuickEntry();
    expect(savedTask("Second task")?.description).toBe("");
  });
});
