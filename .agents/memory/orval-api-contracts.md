---
name: Orval API contracts
description: OpenAPI contract shape constraints for this workspace's split Orval-generated React and Zod clients.
---

Avoid combining path identifiers and query options on a single operation when practical. Orval can generate the same parameter name in both the Zod schema output and TypeScript types barrel, breaking library typechecking. Keep search and pagination query-only or adjust the export boundary rather than editing generated files.

**Why:** The split client and Zod generators export overlapping parameter types for some combined path/query operations.

**How to apply:** Run `pnpm --filter @workspace/api-spec run codegen` after changing the OpenAPI document and verify the workspace typecheck before implementing routes or UI.
