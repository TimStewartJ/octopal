---
name: notion
description: >
  Notion workspace integration. Query databases, create and update pages,
  search content, and manage structured data in Notion.
metadata:
  author: octopal
  version: "0.1"
---

# Notion Integration

You can read and write to the user's Notion workspace via `scripts/notion.sh`.

**IMPORTANT:** Always use `scripts/notion.sh` for Notion access. Never use raw `curl` commands or read the API key from `~/.octopal/notion.json` directly — the key is sensitive and must not appear in command output or logs.

## When to Use

- User asks to check, create, or update items in Notion (tasks, projects, etc.)
- User references "my todo list", "my projects", or any Notion database
- User wants to save structured data (not just notes — use the vault for notes)

## Setup

Requires a Notion API key (create at [notion.so/my-integrations](https://www.notion.so/my-integrations)).

Configure in `~/.octopal/notion.json`:
```json
{
  "apiKey": "ntn_...",
  "databases": {
    "todo": "abc123-...",
    "projects": "def456-..."
  }
}
```

Alternatively, set `NOTION_API_KEY` as an environment variable (takes precedence over the config file).

## Core Workflow

### 1. Discover available databases
```bash
scripts/notion.sh list-dbs
```

### 2. Learn a database schema before querying
```bash
scripts/notion.sh describe <db-name-or-id>
```
This returns column names, types, and select/multi-select options. **Always describe a database before your first query** so you know the valid property names and filter values.

### 3. Search across the workspace
```bash
scripts/notion.sh search "query text"
```

### 4. Query a database
```bash
# All items (first 100)
scripts/notion.sh query <db-name-or-id>

# With filter (JSON)
scripts/notion.sh query <db-name-or-id> '{"property":"Status","status":{"equals":"In Progress"}}'

# With sorts (JSON)
scripts/notion.sh query <db-name-or-id> '' '[{"property":"Due Date","direction":"ascending"}]'
```

### 5. Read a page
```bash
# Page properties
scripts/notion.sh get-page <page-id>

# Page content blocks
scripts/notion.sh get-blocks <page-id>
```

### 6. Create a page in a database
```bash
# Properties as JSON
scripts/notion.sh create-page <db-name-or-id> '{"Name":{"title":[{"text":{"content":"My Task"}}]},"Status":{"status":{"name":"Not Started"}}}'
```

### 7. Update a page
```bash
scripts/notion.sh update-page <page-id> '{"Status":{"status":{"name":"Done"}}}'
```

### 8. Append content blocks to a page
```bash
scripts/notion.sh append-blocks <page-id> '[{"paragraph":{"rich_text":[{"text":{"content":"New paragraph"}}]}}]'
```

## Tips

- **Always `describe` first** — property names are case-sensitive and must match exactly
- Database names are shorthand keys from `~/.octopal/notion.json` — use them instead of raw UUIDs
- The Notion API returns rich nested JSON — parse what you need, don't dump everything
- For relation properties, the value is an array of page IDs
- Filter syntax follows the [Notion API filter format](https://developers.notion.com/reference/post-database-query-filter)
- When creating pages, the title property uses `{"title":[{"text":{"content":"..."}}]}` format
- Status properties use `{"status":{"name":"..."}}` format
- Select properties use `{"select":{"name":"..."}}` format
