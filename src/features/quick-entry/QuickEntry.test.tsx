import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { QuickEntry } from "./QuickEntry";
import type { Task } from "../../lib/types";

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
});
