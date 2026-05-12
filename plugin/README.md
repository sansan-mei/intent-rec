# Huili Heuristic Dify Plugin

用于替换工作流中的“启发式处理”代码节点，提供单工具输出：

- `after_let`：给下游 LLM 的规范化 query
- `confirmed_attributes`：合并后的属性对象（含 price_min / price_max 补齐）
- `heuristic`：命中明细，便于排查

## 本地调试

1. 在 Dify 插件开发环境中创建 `.env`
2. 启动插件入口（`main.py`）
3. 在 Dify 工作流中调用 `heuristic_preprocess`，传入：
   - `query`
   - `confirmed_attributes`（可选）

## 注意

当前实现聚焦你现有链路里最关键的启发式价位处理，后续可继续把 `src/priceHeuristic.ts` 的规则逐步平移进插件。
