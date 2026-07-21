import type { Task } from "./types";

function localDate(offsetDays = 0): string {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function timestamp(offsetMinutes = 0): string {
  return new Date(Date.now() + offsetMinutes * 60_000).toISOString();
}

export function demoTasks(): Task[] {
  return [
    {
      id: "demo-launch",
      title: "Review the launch brief",
      bucket: "today",
      priority: "high",
      area: "work",
      dueDate: localDate(),
      estimateMinutes: 25,
      orderKey: "000001",
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp(-360),
      updatedAt: timestamp(-180),
    },
    {
      id: "demo-dentist",
      title: "Book a dentist appointment",
      bucket: "today",
      priority: "high",
      area: "personal",
      dueDate: null,
      estimateMinutes: 10,
      orderKey: "000002",
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp(-320),
      updatedAt: timestamp(-320),
    },
    {
      id: "demo-feedback",
      title: "Reply to design feedback",
      bucket: "today",
      priority: "low",
      area: "work",
      dueDate: null,
      estimateMinutes: 30,
      orderKey: "000001",
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp(-260),
      updatedAt: timestamp(-260),
    },
    {
      id: "demo-groceries",
      title: "Pick up groceries on the way home",
      bucket: "today",
      priority: "low",
      area: "personal",
      dueDate: null,
      estimateMinutes: null,
      orderKey: "000002",
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp(-220),
      updatedAt: timestamp(-220),
    },
    {
      id: "demo-goals",
      title: "Outline quarterly goals",
      bucket: "inbox",
      priority: "high",
      area: "work",
      dueDate: localDate(2),
      estimateMinutes: 45,
      orderKey: "000001",
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp(-160),
      updatedAt: timestamp(-160),
    },
    {
      id: "demo-hike",
      title: "Plan the weekend hike",
      bucket: "inbox",
      priority: "low",
      area: "personal",
      dueDate: null,
      estimateMinutes: null,
      orderKey: "000001",
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp(-100),
      updatedAt: timestamp(-100),
    },
    {
      id: "demo-expenses",
      title: "Submit travel expenses",
      bucket: "inbox",
      priority: "low",
      area: "work",
      dueDate: localDate(4),
      estimateMinutes: 15,
      orderKey: "000002",
      completedAt: null,
      deletedAt: null,
      createdAt: timestamp(-60),
      updatedAt: timestamp(-60),
    },
    {
      id: "demo-complete",
      title: "Send weekly update",
      bucket: "today",
      priority: "low",
      area: "work",
      dueDate: null,
      estimateMinutes: 20,
      orderKey: "000003",
      completedAt: timestamp(-30),
      deletedAt: null,
      createdAt: timestamp(-1440),
      updatedAt: timestamp(-30),
    },
  ];
}
