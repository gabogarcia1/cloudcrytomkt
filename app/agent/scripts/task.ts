// Operator CLI for consulting tasks (pendiente → en_curso → entregada).
//   pnpm exec tsx scripts/task.ts list
//   pnpm exec tsx scripts/task.ts set <taskId> en_curso "Kickoff agendado"
//   pnpm exec tsx scripts/task.ts set <taskId> entregada "Informe enviado"
import { TASK_STATES, type TaskState, listTasks, setTaskState } from "../src/fulfillment/tasks.js";

const [cmd, taskId, state, ...note] = process.argv.slice(2);

if (cmd === "list" || cmd === undefined) {
  const tasks = listTasks();
  if (tasks.length === 0) console.log("(no tasks)");
  for (const t of tasks) {
    console.log(`${t.taskId}  ${t.state.padEnd(10)} ${t.service} · ${t.hours} h · buyer ${t.buyer} · order ${t.groupId}`);
    for (const n of t.notes) console.log(`    ${n}`);
  }
} else if (cmd === "set" && taskId && TASK_STATES.includes(state as TaskState)) {
  const t = setTaskState(taskId, state as TaskState, note.join(" ") || undefined);
  console.log(`${t.taskId} → ${t.state}`);
} else {
  console.error(`usage: task.ts list | set <taskId> <${TASK_STATES.join("|")}> [note]`);
  process.exit(2);
}
