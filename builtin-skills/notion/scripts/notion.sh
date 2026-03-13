#!/usr/bin/env bash
# Notion API wrapper for OctoPal.
# Reads NOTION_API_KEY from environment.
# Reads database shorthand mappings from ~/.octopal/notion.json (optional).
#
# Usage:
#   notion.sh list-dbs                              # list configured database shorthands
#   notion.sh describe <db>                         # show database schema (columns, types, options)
#   notion.sh search <query>                        # search across workspace
#   notion.sh query <db> [filter_json] [sorts_json] # query a database
#   notion.sh get-page <page-id>                    # get page properties
#   notion.sh get-blocks <page-id>                  # get page content blocks
#   notion.sh create-page <db> <properties_json>    # create a page in a database
#   notion.sh update-page <page-id> <properties_json> # update page properties
#   notion.sh append-blocks <page-id> <blocks_json> # append content blocks to a page

set -euo pipefail

API_KEY="${NOTION_API_KEY:-}"
if [ -z "$API_KEY" ]; then
  echo "Error: NOTION_API_KEY environment variable not set" >&2
  exit 1
fi

API_URL="https://api.notion.com/v1"
API_VERSION="2022-06-28"
CONFIG_FILE="${OCTOPAL_NOTION_CONFIG:-$HOME/.octopal/notion.json}"

# Resolve a database name or ID to a UUID
resolve_db() {
  local input="$1"
  # If it looks like a UUID already, use it directly
  if [[ "$input" =~ ^[0-9a-f-]{32,36}$ ]]; then
    echo "$input"
    return
  fi
  # Look up shorthand in config file
  if [ -f "$CONFIG_FILE" ]; then
    local id
    id=$(python3 -c "
import json, sys
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
dbs = cfg.get('databases', {})
name = '$input'
if name in dbs:
    print(dbs[name])
else:
    print('', end='')
" 2>/dev/null)
    if [ -n "$id" ]; then
      echo "$id"
      return
    fi
  fi
  echo "Error: Unknown database '$input'. Use a UUID or configure it in $CONFIG_FILE" >&2
  exit 1
}

# Make an API request
api() {
  local method="$1" endpoint="$2"
  shift 2
  curl -s -X "$method" "$API_URL$endpoint" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Notion-Version: $API_VERSION" \
    -H "Content-Type: application/json" \
    "$@"
}

# Format database schema into a readable summary
format_schema() {
  python3 -c "
import json, sys
data = json.load(sys.stdin)
title = data.get('title', [{}])
if isinstance(title, list) and title:
    name = title[0].get('plain_text', 'Untitled')
else:
    name = 'Untitled'
print(f'Database: {name}')
print(f'ID: {data[\"id\"]}')
print()
print('Properties:')
props = data.get('properties', {})
for pname, pinfo in sorted(props.items()):
    ptype = pinfo.get('type', 'unknown')
    extra = ''
    if ptype == 'select':
        opts = [o['name'] for o in pinfo.get('select', {}).get('options', [])]
        if opts:
            joined = ', '.join(opts)
            extra = f' [{joined}]'
    elif ptype == 'multi_select':
        opts = [o['name'] for o in pinfo.get('multi_select', {}).get('options', [])]
        if opts:
            joined = ', '.join(opts)
            extra = f' [{joined}]'
    elif ptype == 'status':
        opts = [o['name'] for o in pinfo.get('status', {}).get('options', [])]
        if opts:
            joined = ', '.join(opts)
            extra = f' [{joined}]'
    elif ptype == 'relation':
        rel_db = pinfo.get('relation', {}).get('database_id', '')
        if rel_db: extra = f' -> {rel_db}'
    elif ptype == 'formula':
        expr = pinfo.get('formula', {}).get('expression', '')
        if expr: extra = f' = {expr}'
    print(f'  {pname}: {ptype}{extra}')
"
}

# Format query results into a readable summary
format_results() {
  python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])
print(f'Found {len(results)} result(s)')
if data.get('has_more'): print('(more results available)')
print()
for page in results:
    pid = page['id']
    props = page.get('properties', {})
    # Find the title property
    title = ''
    for pname, pinfo in props.items():
        if pinfo.get('type') == 'title':
            texts = pinfo.get('title', [])
            title = ''.join(t.get('plain_text', '') for t in texts)
            break
    if not title: title = '(untitled)'
    # Collect key properties
    summary = []
    for pname, pinfo in sorted(props.items()):
        ptype = pinfo.get('type', '')
        val = None
        if ptype == 'status':
            s = pinfo.get('status')
            if s: val = s.get('name', '')
        elif ptype == 'select':
            s = pinfo.get('select')
            if s: val = s.get('name', '')
        elif ptype == 'date':
            d = pinfo.get('date')
            if d: val = d.get('start', '')
        elif ptype == 'checkbox':
            val = 'Yes' if pinfo.get('checkbox') else 'No'
        elif ptype == 'number':
            val = pinfo.get('number')
        elif ptype == 'rich_text':
            texts = pinfo.get('rich_text', [])
            val = ''.join(t.get('plain_text', '') for t in texts)
        elif ptype == 'multi_select':
            opts = pinfo.get('multi_select', [])
            val = ', '.join(o.get('name', '') for o in opts)
        elif ptype == 'relation':
            rels = pinfo.get('relation', [])
            if rels: val = f'{len(rels)} linked'
        if val is not None and val != '' and ptype != 'title':
            summary.append(f'{pname}={val}')
    summary_str = ' | '.join(summary[:6])
    print(f'- [{title}] (id: {pid})')
    if summary_str:
        print(f'  {summary_str}')
"
}

# --- Commands ---

COMMAND="${1:-help}"
shift || true

case "$COMMAND" in
  list-dbs)
    if [ ! -f "$CONFIG_FILE" ]; then
      echo "No config file found at $CONFIG_FILE"
      echo "Create one with database mappings, e.g.:"
      echo '{"databases":{"todo":"abc123-...","projects":"def456-..."}}'
      exit 0
    fi
    python3 -c "
import json
with open('$CONFIG_FILE') as f:
    cfg = json.load(f)
dbs = cfg.get('databases', {})
if not dbs:
    print('No databases configured')
else:
    for name, dbid in sorted(dbs.items()):
        print(f'  {name}: {dbid}')
"
    ;;

  describe)
    DB_ID=$(resolve_db "${1:?Usage: notion.sh describe <db-name-or-id>}")
    api GET "/databases/$DB_ID" | format_schema
    ;;

  search)
    QUERY="${1:?Usage: notion.sh search <query>}"
    api POST "/search" -d "{\"query\":\"$QUERY\"}" | format_results
    ;;

  query)
    DB_ID=$(resolve_db "${1:?Usage: notion.sh query <db-name-or-id> [filter] [sorts]}")
    FILTER="${2:-}"
    SORTS="${3:-}"
    BODY="{}"
    if [ -n "$FILTER" ] && [ -n "$SORTS" ]; then
      BODY="{\"filter\":$FILTER,\"sorts\":$SORTS}"
    elif [ -n "$FILTER" ]; then
      BODY="{\"filter\":$FILTER}"
    elif [ -n "$SORTS" ]; then
      BODY="{\"sorts\":$SORTS}"
    fi
    api POST "/databases/$DB_ID/query" -d "$BODY" | format_results
    ;;

  get-page)
    PAGE_ID="${1:?Usage: notion.sh get-page <page-id>}"
    api GET "/pages/$PAGE_ID"
    ;;

  get-blocks)
    PAGE_ID="${1:?Usage: notion.sh get-blocks <page-id>}"
    api GET "/blocks/$PAGE_ID/children?page_size=100" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for block in data.get('results', []):
    btype = block.get('type', 'unknown')
    content = block.get(btype, {})
    text = ''
    if 'rich_text' in content:
        text = ''.join(t.get('plain_text', '') for t in content['rich_text'])
    elif 'text' in content:
        text = ''.join(t.get('plain_text', '') for t in content['text'])
    prefix = ''
    if btype == 'heading_1': prefix = '# '
    elif btype == 'heading_2': prefix = '## '
    elif btype == 'heading_3': prefix = '### '
    elif btype == 'bulleted_list_item': prefix = '- '
    elif btype == 'numbered_list_item': prefix = '1. '
    elif btype == 'to_do':
        checked = '✅' if content.get('checked') else '⬜'
        prefix = f'{checked} '
    elif btype == 'code':
        lang = content.get('language', '')
        print(f'\`\`\`{lang}')
        print(text)
        print('\`\`\`')
        continue
    elif btype == 'divider':
        print('---')
        continue
    if text or prefix:
        print(f'{prefix}{text}')
"
    ;;

  create-page)
    DB_ID=$(resolve_db "${1:?Usage: notion.sh create-page <db-name-or-id> <properties_json>}")
    PROPERTIES="${2:?Usage: notion.sh create-page <db> <properties_json>}"
    BODY="{\"parent\":{\"database_id\":\"$DB_ID\"},\"properties\":$PROPERTIES}"
    RESULT=$(api POST "/pages" -d "$BODY")
    echo "$RESULT" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if 'id' in data:
    print(f'Created page: {data[\"id\"]}')
    url = data.get('url', '')
    if url: print(f'URL: {url}')
else:
    print(json.dumps(data, indent=2))
"
    ;;

  update-page)
    PAGE_ID="${1:?Usage: notion.sh update-page <page-id> <properties_json>}"
    PROPERTIES="${2:?Usage: notion.sh update-page <page-id> <properties_json>}"
    BODY="{\"properties\":$PROPERTIES}"
    api PATCH "/pages/$PAGE_ID" -d "$BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
if 'id' in data:
    print(f'Updated page: {data[\"id\"]}')
else:
    print(json.dumps(data, indent=2))
"
    ;;

  append-blocks)
    PAGE_ID="${1:?Usage: notion.sh append-blocks <page-id> <blocks_json>}"
    BLOCKS="${2:?Usage: notion.sh append-blocks <page-id> <blocks_json>}"
    BODY="{\"children\":$BLOCKS}"
    api PATCH "/blocks/$PAGE_ID/children" -d "$BODY" | python3 -c "
import json, sys
data = json.load(sys.stdin)
results = data.get('results', [])
print(f'Appended {len(results)} block(s)')
"
    ;;

  help|*)
    echo "Notion API wrapper for OctoPal"
    echo ""
    echo "Usage: notion.sh <command> [args...]"
    echo ""
    echo "Commands:"
    echo "  list-dbs                              List configured database shorthands"
    echo "  describe <db>                         Show database schema"
    echo "  search <query>                        Search across workspace"
    echo "  query <db> [filter] [sorts]           Query a database"
    echo "  get-page <page-id>                    Get page properties"
    echo "  get-blocks <page-id>                  Get page content blocks"
    echo "  create-page <db> <properties_json>    Create a page in a database"
    echo "  update-page <page-id> <props_json>    Update page properties"
    echo "  append-blocks <page-id> <blocks_json> Append content blocks"
    echo ""
    echo "Config: $CONFIG_FILE"
    echo "API Key: \${NOTION_API_KEY}"
    exit 0
    ;;
esac
