export interface TaskRecord {
  taskId: string;
  serverId: string;
  sessionId: string;
  /** Epoch ms when the task was started; used to detect tasks that never produced output. */
  createdAt?: number;
}

const tasks = new Map<string, TaskRecord>();

export function registerTask(task: TaskRecord) {
  tasks.set(task.taskId, task);
}

export function getTask(taskId: string): TaskRecord | undefined {
  return tasks.get(taskId);
}

export function removeTask(taskId: string) {
  tasks.delete(taskId);
}
