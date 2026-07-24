import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { LlmSettingsStatus } from "../../lib/taskClient";
import { AiSettingsDialog } from "./AiSettingsDialog";

const status: LlmSettingsStatus = {
  openai: { configured: true, source: "saved" },
  anthropic: { configured: true, source: "environment" },
  pendingJobs: 4,
  failedJobs: 2,
};

function renderDialog(overrides: Partial<ComponentProps<typeof AiSettingsDialog>> = {}) {
  const props: ComponentProps<typeof AiSettingsDialog> = {
    open: true,
    runtime: "tauri",
    status,
    onOpenChange: vi.fn(),
    onSave: vi.fn(async () => status),
    ...overrides,
  };
  return { props, ...render(<AiSettingsDialog {...props} />) };
}

describe("AI settings dialog", () => {
  it("never renders saved keys and reports provider and queue status", () => {
    renderDialog();

    expect(screen.getByLabelText("OpenAI API key")).toHaveValue("");
    expect(screen.getByLabelText("Anthropic API key")).toHaveValue("");
    expect(screen.queryByDisplayValue(/sk-/)).not.toBeInTheDocument();
    expect(screen.getByText("Saved on this Mac")).toBeInTheDocument();
    expect(screen.getByText("From environment")).toBeInTheDocument();
    expect(screen.getByText("4 pending")).toBeInTheDocument();
    expect(screen.getByText("2 need attention")).toBeInTheDocument();
  });

  it("sends only replacement fields that the user entered", async () => {
    const onSave = vi.fn(async () => status);
    renderDialog({ onSave });

    fireEvent.change(screen.getByLabelText("Anthropic API key"), {
      target: { value: "sk-ant-replacement" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({
      anthropicApiKey: "sk-ant-replacement",
    }));
  });

  it("can explicitly clear a saved override without exposing it", async () => {
    const onSave = vi.fn(async () => ({
      ...status,
      openai: { configured: false, source: null },
    } satisfies LlmSettingsStatus));
    renderDialog({ onSave });

    fireEvent.click(screen.getByRole("button", { name: "Clear saved OpenAI key" }));
    fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ openaiApiKey: null }));
  });

  it("shows the message from a serialized native validation error", async () => {
    const onSave = vi.fn(async () => {
      throw {
        code: "invalid_input",
        message: "The OpenAI API key could not be verified",
      };
    });
    renderDialog({ onSave });

    fireEvent.change(screen.getByLabelText("OpenAI API key"), {
      target: { value: "sk-invalid" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save AI settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The OpenAI API key could not be verified",
    );
  });

  it("keeps API keys out of browser storage and disables editing in browser preview", () => {
    renderDialog({
      runtime: "browser",
      status: {
        openai: { configured: false, source: null },
        anthropic: { configured: false, source: null },
        pendingJobs: 0,
        failedJobs: 0,
      },
    });

    expect(screen.getByText(/desktop app is required/i)).toBeInTheDocument();
    expect(screen.getByLabelText("OpenAI API key")).toBeDisabled();
    expect(screen.getByLabelText("Anthropic API key")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save AI settings" })).toBeDisabled();
    expect(Object.keys(localStorage).some((key) => key.includes("llm"))).toBe(false);
  });
});
