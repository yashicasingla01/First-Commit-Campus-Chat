---
name: Clerk SDK wiring
description: Version compatibility for Replit-managed Clerk's browser key helper.
---

Check the installed `@clerk/react` version exports before copying the required `publishableKeyFromHost` helper import. If the installed SDK does not export it, use a compatible SDK version rather than replacing the helper with a raw key or a local approximation. The development proxy URL can be intentionally empty while the Replit-managed publish flow supplies production proxy configuration.

**Why:** The required helper is version-sensitive; an otherwise correct Clerk setup can fail TypeScript compilation when the client SDK is older.

**How to apply:** Confirm the helper in the installed package and run the frontend typecheck before restarting the app after Clerk changes.
