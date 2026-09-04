# TG Adaptive Cards Consistency Report

Generated: 2026-09-04

## Summary
Verified `app/panels/cards.js` and `src/gateway/mounts/57-cards.js` against existing TG patterns.

## Findings

### 1. TG_PANELS Registration Pattern
**Status: ✅ CONSISTENT**

`app/panels/cards.js` follows the same pattern as `app/panels/artifacts.js`:
```javascript
(window.TG_PANELS = window.TG_PANELS || []).push({
  id: 'cards',
  title: 'Adaptive Cards',
  render
});
```

### 2. Mount Pattern
**Status: ℹ️ INTENTIONALLY DIFFERENT**

- `57-cards.js`: `auth: 'bearer'` (framework-provided)
- `40-artifacts.js`: `auth: 'none'` + manual `authBot()` in handler

This difference is intentional: artifacts supports SSE streams via `?token=` URL params (browser EventSource can't set headers), requiring manual auth. Cards only needs regular API calls, so `auth: 'bearer'` is appropriate.

### 3. Auth Pattern vs 20-chat.js
**Status: ✅ CONSISTENT**

Both `57-cards.js` and `20-chat.js` use `auth: 'bearer'`.

### 4. XSS Review (app/cards.js Chart Primitive)
**Status: ✅ SAFE**

Chart uses `document.createElementNS('http://www.w3.org/2000/svg', ...)` with:
- All text content via `textContent` (line 180)
- No `innerHTML` anywhere in the file
- Attributes set via `setAttribute()` with `String()` conversions

### 5. Test Results
```
✔ 37 passed
✖ 2 failed (file mode 0600 issues in artifacts/plugins tests - unrelated to cards)
```

## Violations Found
None. All patterns are consistent or intentionally different for valid technical reasons.

## Files Modified
None.
