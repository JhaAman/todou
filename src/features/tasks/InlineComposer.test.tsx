import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { InlineComposer } from "./InlineComposer";

it("dismisses a default-only draft when focus leaves the composer", () => {
  const onCancel = vi.fn();
  render(
    <>
      <InlineComposer
        bucket="today"
        defaultArea="personal"
        onCreate={vi.fn()}
        onCreated={vi.fn()}
        onCancel={onCancel}
      />
      <button>Outside</button>
    </>,
  );

  fireEvent.blur(screen.getByLabelText("Task title"), {
    relatedTarget: screen.getByRole("button", { name: "Outside" }),
  });

  expect(onCancel).toHaveBeenCalledOnce();
});

it("keeps user-entered text when focus leaves the composer", () => {
  const onCancel = vi.fn();
  render(
    <>
      <InlineComposer
        bucket="inbox"
        defaultArea="work"
        onCreate={vi.fn()}
        onCreated={vi.fn()}
        onCancel={onCancel}
      />
      <button>Outside</button>
    </>,
  );
  fireEvent.change(screen.getByLabelText("Task title"), {
    target: { value: "Review brief tomorrow 25m" },
  });

  fireEvent.blur(screen.getByLabelText("Task title"), {
    relatedTarget: screen.getByRole("button", { name: "Outside" }),
  });

  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Task title")).toHaveValue("Review brief tomorrow 25m");
});

it("keeps details the user changed when focus leaves the composer", () => {
  const onCancel = vi.fn();
  render(
    <>
      <InlineComposer
        bucket="today"
        defaultArea="personal"
        onCreate={vi.fn()}
        onCreated={vi.fn()}
        onCancel={onCancel}
      />
      <button>Outside</button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "High priority" }));

  fireEvent.blur(screen.getByLabelText("Task title"), {
    relatedTarget: screen.getByRole("button", { name: "Outside" }),
  });

  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "High priority" })).toHaveAttribute("aria-pressed", "true");
});

it("keeps a user-changed area without treating the default area as meaningful", () => {
  const onCancel = vi.fn();
  render(
    <>
      <InlineComposer
        bucket="today"
        defaultArea="personal"
        onCreate={vi.fn()}
        onCreated={vi.fn()}
        onCancel={onCancel}
      />
      <button>Outside</button>
    </>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Work task" }));

  fireEvent.blur(screen.getByLabelText("Task title"), {
    relatedTarget: screen.getByRole("button", { name: "Outside" }),
  });

  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Work task" })).toHaveAttribute("aria-pressed", "true");
});

it("does not treat focus moving within the composer as selecting away", () => {
  const onCancel = vi.fn();
  render(
    <InlineComposer
      bucket="today"
      defaultArea="work"
      onCreate={vi.fn()}
      onCreated={vi.fn()}
      onCancel={onCancel}
    />,
  );

  fireEvent.blur(screen.getByLabelText("Task title"), {
    relatedTarget: screen.getByRole("button", { name: "High priority" }),
  });

  expect(onCancel).not.toHaveBeenCalled();
});
