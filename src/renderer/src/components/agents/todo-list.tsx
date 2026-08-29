"use client";
// beui.dev/components/agents/todo-list
//
// 包装层：根据设置开关在「官方原版 / PiDeck 定制变体」之间切换。
// 定制版额外支持 compact 密度（官方无此 prop，切官方时丢弃即可）。

import { useBeuiOfficial } from "@/hooks/useBeuiOfficial";
import { TodoList as CustomTodoList } from "./todo-list.custom";
import { TodoList as OfficialTodoList } from "@/components/beui-official/agents/todo-list";

export type { TodoItemStatus, TodoItem, TodoListProps } from "./todo-list.custom";

type TodoListProps = import("./todo-list.custom").TodoListProps;

export function TodoList(props: TodoListProps) {
  const official = useBeuiOfficial();
  if (official) {
    // 官方版没有 compact 密度开关，剥离该定制 prop 后转发
    const { compact: _compact, ...rest } = props;
    return <OfficialTodoList {...rest} />;
  }
  return <CustomTodoList {...props} />;
}
