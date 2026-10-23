/**
 * Consulting tasks: a paid hours package becomes a task the operator moves
 * through `pendiente → en_curso → entregada` (scripts/task.ts). The buyer
 * sees the state in "Mis pedidos" / order_status.
 */

import { dataPath, readJson, writeJson } from "./fileDb.js";

export const TASK_STATES = ["pendiente", "en_curso", "entregada", "cancelada"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export interface Task {
  taskId: string;
  orderId: string;
  groupId: string;
  buyer: string;
  service: string;
  hours: number;
  state: TaskState;
  notes: string[];
  createdAt: string;
  updatedAt: string;
}

const path = () => dataPath("TASKS_DB_PATH", "tasks.json");
const load = () => readJson<Record<string, Task>>(path(), {});

/** Create once per order line (idempotent by taskId). */
export function ensureTask(t: Omit<Task, "state" | "notes" | "createdAt" | "updatedAt">): Task {
  const all = load();
  const existing = all[t.taskId];
  if (existing !== undefined) return existing;
  const now = new Date().toISOString();
  const task: Task = { ...t, state: "pendiente", notes: [], createdAt: now, updatedAt: now };
  all[t.taskId] = task;
  writeJson(path(), all);
  return task;
}

export function getTask(taskId: string): Task | null {
  return load()[taskId] ?? null;
}

export function listTasks(): Task[] {
  return Object.values(load()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function setTaskState(taskId: string, state: TaskState, note?: string): Task {
  const all = load();
  const task = all[taskId];
  if (task === undefined) throw new Error(`task ${taskId} not found`);
  task.state = state;
  if (note) task.notes.push(`${new Date().toISOString()} ${note}`);
  task.updatedAt = new Date().toISOString();
  writeJson(path(), all);
  return task;
}
