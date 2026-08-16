/**
 * 本地待办 UI / IPC API —— 薄 facade，委托 TodoService
 */
import type { TodoItem } from '@sailfish/shared-types'
import {
  getTodoService,
  type TodoCreateInput,
  type TodoJournalInput,
  type TodoListFilter,
  type TodoSourceInput,
  type TodoUpdatePatch,
} from './store'

export type { TodoCreateInput, TodoJournalInput, TodoListFilter, TodoSourceInput, TodoUpdatePatch }

export function listTodos(filter: TodoListFilter = {}): TodoItem[] {
  return getTodoService().list(filter)
}

export function countOverdueTodos(now = new Date()): number {
  return getTodoService().countOverdue(now)
}

export async function createTodo(input: TodoCreateInput): Promise<TodoItem> {
  return getTodoService().create(input)
}

export async function updateTodo(id: string, patch: TodoUpdatePatch): Promise<TodoItem | null> {
  return getTodoService().update(id, patch)
}

export async function completeTodo(id: string): Promise<TodoItem | null> {
  return getTodoService().complete(id)
}

export async function deleteTodo(id: string): Promise<boolean> {
  return getTodoService().delete(id)
}

export async function appendTodoJournal(id: string, entry: TodoJournalInput): Promise<TodoItem | null> {
  return getTodoService().appendJournal(id, entry)
}

export async function addTodoSource(id: string, source: TodoSourceInput): Promise<TodoItem | null> {
  return getTodoService().addSource(id, source)
}
