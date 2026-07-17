# Conversation 模块 SPEC

> Last verified: 2026-07-17

## 职责

会话领域模型：`Conversation` 聚合根、策略表、`Companion` 关系线、transcript 切分。

## 从这里创建任务（companion → task）

用户在联络里点某条消息「从这里创建任务」时，设计意图是：

**以当前这条为终点，倒序往前取一段上下文；不要带上这条之后的消息。**

往前取时：
- 按用户对话扩窗（间隔约 6 小时内、最多约 10 段）；主动通知不当切断点。
- 窗口内的主动通知要带上；紧挨窗口第一条用户话之前的那条通知也要带上（常见「通知 → 用户接着回」）。
- 若点的就是主动通知本身，只带这一条。

实现入口：`Companion.extractTaskWithLiveOverlay` → `Conversation.extractTaskFromRecords`。
与 task 的「另开一聊」（从头截到第 N 个）不是同一套语义。
