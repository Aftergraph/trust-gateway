# W0.1 Durable Conversations

**Status**: Complete ✅

## Summary

Implemented durable conversations with SQLite persistence, replay capability, and tenant scoping.

## Changes

### Files Created

- `src/gateway/conversations.js` - ConversationStore class with create/list/get/append/replay/delete
- `src/gateway/mounts/21-conversations.js` - API endpoints for conversations
- `tests/conversations.test.js` - Full test suite (10 tests)

### Files Modified

- `src/gateway/db.js` - Added conversations and messages tables

## Features

- **Conversations**: CRUD operations with tenant scoping
- **Messages**: Append and retrieve with cursor-based pagination (SSE-ready)
- **Persistence**: Data survives db restart
- **Tenant isolation**: Tenants can't see each other's data
- **Fail-closed**: Corrupt db file handling

## API Endpoints

- `GET /v2/conversations` - List all conversations for tenant
- `POST /v2/conversations` - Create conversation (body: {title})
- `GET /v2/conversations/:id` - Get single conversation
- `DELETE /v2/conversations/:id` - Delete conversation and messages
- `GET /v2/conversations/:id/messages?since=T` - Get messages (cursor-based)
- `POST /v2/conversations/:id/messages` - Append message (body: {role, content})

## Tests

All 10 tests pass:
- Create and list
- Tenant scoping
- Get by id
- Messages append/retrieve
- Cursor-based filtering
- Full history replay
- Persistence across restart
- Delete
