<div align="center">

# 🤖 Twenty CRM MCP Server

**Transform your CRM into an AI-powered assistant**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/runtime-bun-fbf0df?logo=bun)](https://bun.sh)
[![Twenty CRM](https://img.shields.io/badge/Twenty_CRM-Compatible-blue)](https://twenty.com)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io/)

*A Model Context Protocol server that connects [Twenty CRM](https://twenty.com) with Claude and other AI assistants, enabling natural language interactions with your customer data.*

[🚀 Quick Start](#-installation) • [📖 Usage Examples](#-usage) • [🛠️ API Reference](#-api-reference) • [🤝 Contributing](#-contributing)

</div>

---

## ✨ Features

<table>
<tr>
<td width="50%">

### 🔄 **Complete CRUD Operations**
Create, read, update, and delete people, companies, tasks, and notes with simple commands

### 🧠 **Dynamic Schema Discovery** 
Automatically adapts to your Twenty CRM configuration and custom fields

### 🔍 **Advanced Search**
Search across multiple object types with intelligent filtering and natural language queries

</td>
<td width="50%">

### 📊 **Metadata Access**
Retrieve schema information and field definitions dynamically

### 💬 **Natural Language Interface**
Use conversational commands to manage your CRM data effortlessly

### ⚡ **Real-time Updates**
All changes sync immediately with your Twenty CRM instance

</td>
</tr>
</table>

---

## 🚀 Installation

### Prerequisites

- [Bun](https://bun.sh) 1.3 or higher (runs the TypeScript source directly — no build step)
- A Twenty CRM instance (cloud or self-hosted)
- Claude Desktop or compatible MCP client

### Setup

1. **Clone the repository**:
```bash
git clone https://github.com/mhenry3164/twenty-crm-mcp-server.git
cd twenty-crm-mcp-server
```

2. **Install dependencies**:
```bash
bun install
```

3. **Get your Twenty CRM API key**:
   - Log in to your Twenty CRM workspace
   - Navigate to Settings → API & Webhooks (under Developers)
   - Generate a new API key

4. **Configure Claude Desktop**:

Add the server to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "twenty-crm": {
      "command": "bun",
      "args": ["run", "/path/to/twenty-crm-mcp-server/src/index.ts"],
      "env": {
        "TWENTY_API_KEY": "your_api_key_here",
        "TWENTY_BASE_URL": "https://api.twenty.com"
      }
    }
  }
}
```

For self-hosted Twenty instances, change `TWENTY_BASE_URL` to your domain.

5. **Restart Claude Desktop** to load the new server.

---

## 💬 Usage

Once configured, you can use natural language to interact with your Twenty CRM:

### 👥 People Management
```
"List the first 10 people in my CRM"
"Create a new person named John Doe with email john@example.com"
"Update Sarah's job title to Senior Developer"
"Find all people working at tech companies"
```

### 🏢 Company Management
```
"Show me all companies with more than 100 employees"
"Create a company called Tech Solutions with domain techsolutions.com"
"Update Acme Corp's annual revenue to $5M"
```

### ✅ Task Management
```
"Create a task to follow up with John next Friday"
"Show me all overdue tasks"
"Mark the task 'Call client' as completed"
```

### 📝 Notes & Search
```
"Add a note about my meeting with the client today"
"Search for any records mentioning 'blockchain'"
"Find all contacts without LinkedIn profiles"
```

---

## 🛠️ API Reference

The server registers 43 tools grouped below. Every tool's `description` embeds Examples / filter-grammar hints (few-shot prompts) so the calling model picks the right syntax without extra priming.

### Filter grammar (list_* + query_records + count_records)

Twenty's REST filter dialect, verified against Twenty v1.19:

```
Operators:    [eq] [neq] [in] [nin] [like] [ilike] [startsWith]
              [gt] [gte] [lt] [lte] [is]
⚠ [like] is CASE-SENSITIVE. Use [ilike] for case-insensitive match.
[nilike] is not supported; compose with or(...)/[neq] instead.
Composition: and(clauseA,clauseB,...)   |   or(clauseA,clauseB,...)
Composite fields: dot-notation
  name.firstName, name.lastName
  emails.primaryEmail, phones.primaryPhoneNumber
  address.addressCity, address.addressPostcode, address.addressCountry
  domainName.primaryLinkUrl, linkedinLink.primaryLinkUrl
Soft-delete guard: deletedAt[is]:NULL  (auto-added; set include_deleted=true to bypass)
Pagination:  limit + starting_after=<pageInfo.endCursor>  (cursor, preferred)
             limit + offset (slower at scale)
Ordering:    order_by=createdAt[DescNullsFirst]
Relations:   depth=0|1|2
```

<details>
<summary><strong>👥 People + 🏢 Companies + 📝 Notes + ✅ Tasks — CRUD + rich list</strong></summary>

- `create_person` / `get_person` / `update_person` / `delete_person`
- `list_people` — filter, order_by, cursor pagination, soft-delete toggle, PrudAI custom fields (`prudaiMarketing*`)
- `create_company` / `get_company` / `update_company` / `delete_company`
- `list_companies` — same params + `address.addressCity`, `domainName.primaryLinkUrl` filters
- `create_note` / `get_note` / `update_note` / `delete_note` / `list_notes`
- `create_task` / `get_task` / `update_task` / `delete_task` / `list_tasks`

Flat convenience inputs (`firstName`, `email`, `domainName` as a string, `body` as plain text) are auto-transformed into Twenty's composite fields (`name`, `emails`, `domainName: { primaryLinkUrl, … }`, `bodyV2`) on send.

</details>

<details>
<summary><strong>🔗 Targets — link notes/tasks to people & companies</strong></summary>

- `create_note_target` / `list_note_targets` / `delete_note_target`
- `create_task_target` / `list_task_targets` / `delete_task_target`
- `list_notes_for_person` / `list_tasks_for_person` — convenience joins via noteTargets/taskTargets

</details>

<details>
<summary><strong>🔍 Generic query + metadata + search</strong></summary>

- `query_records` — list ANY Twenty object type (people, companies, notes, tasks, noteTargets, taskTargets, opportunities, messageThreads, messages, custom objects). Same filter grammar as `list_people`.
- `count_records` — returns `totalCount` for a filter (single cheap request).
- `get_metadata_objects` / `get_object_metadata` — schema introspection.
- `search_records` — full-text across object types.

</details>

<details>
<summary><strong>📊 Aggregates + distinct (psql-backed)</strong></summary>

- `aggregate_records` — `GROUP BY` + count/sum/avg/min/max on any object. Friendly composite paths (`address.addressCity`) are translated to the flat Postgres column name (`addressAddressCity`).
- `distinct_values` — distinct values of a field with counts.

Both execute read-only SQL inside the `twenty-db-1` container.

</details>

<details>
<summary><strong>🛢 run_sql_readonly — psql escape hatch</strong></summary>

Run arbitrary read-only SQL inside the Twenty Postgres container. Guards:
- Must start with `SELECT`, `WITH`, `EXPLAIN`, `VALUES`, `TABLE`, or `SHOW`.
- Forbidden keywords: `insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|call|vacuum|refresh|lock|begin|commit|rollback|prepare|discard|reset|cluster`.
- Multi-statement SQL is rejected (inner semicolons).
- Wrapped with `SET default_transaction_read_only = on; SET statement_timeout = '30s'; SET search_path TO "<workspace schema>", public;`.
- Max 10 000 rows returned.

**Postgres quirk**: unquoted identifiers are folded to lowercase. Always double-quote camelCase columns — `"jobTitle"`, `"addressAddressCity"`, `"nameFirstName"`, `"deletedAt"`, `"prudaiMarketingSourceSystem"`. Lowercase names (`id`, `city`, `name`) don't need quoting.

</details>

<details>
<summary><strong>🧬 graphql_query — arbitrary GraphQL</strong></summary>

- `graphql_query` — POST against `{baseUrl}/graphql` with `{ query, variables, operationName }`. Use for aggregates, connection-style pagination, and relation selection the REST API can't express cleanly.

</details>

<details>
<summary><strong>📦 Batch + bulk + merge + link</strong></summary>

- `batch_upsert_people` — parallel upsert; dedup order: `emails.primaryEmail` → `firstName+lastName+companyId`.
- `batch_upsert_companies` — parallel upsert; dedup order: `domainName` → `name+city` → `name`.
- `bulk_update_by_filter` — patch every record matching a filter; `dryRun: true` by default.
- `merge_people` — merge duplicates into a primary: re-points noteTargets/taskTargets, copies null-on-primary fields, soft-deletes duplicates.
- `link_person_to_company` — shortcut to set `companyId` on a person.
- `bulk_attach_note` — attach one existing note to many persons/companies in one call.

Concurrency: 8 parallel requests per batch tool.

</details>

### Worked example: "100 architects in Twente"

Twente spans 12 municipalities (Enschede, Hengelo, Almelo, Oldenzaal, Borne, Losser, Haaksbergen, Tubbergen, Dinkelland, Wierden, Hof van Twente, Rijssen-Holten). Most `person.city` values are empty in practice — join via `companyId` instead.

**Watch out for the title-vs-tag mismatch.** `jobTitle[like]:"%architect%"` is case-sensitive and only finds 2,136 rows. `[ilike]` brings it to 10,841. The *authoritative* tag `prudaiMarketingSourceSystem = "architectenregister"` is 13,956 rows — those are the records imported from the Dutch Architectenregister and they are the real answer to "how many architects?"

Ground truth for Twente (verified via psql JOIN):
- **91 architects** at Twente-based companies (authoritative filter + `addressAddressCity` IN Twente cities).

#### Path A — two REST calls

1. Get Twente company ids:
   ```
   list_companies
     filter: address.addressCity[in]:["Enschede","Hengelo","Almelo","Oldenzaal","Borne","Losser","Haaksbergen","Tubbergen","Dinkelland","Wierden","Hof van Twente","Rijssen-Holten"]
     limit: 200
   ```
2. Filter architects by those companyIds:
   ```
   list_people
     filter: and(prudaiMarketingSourceSystem[eq]:"architectenregister",companyId[in]:[<id1>,<id2>,...])
     limit: 100
   ```

#### Path B — single SQL JOIN (fastest)

```
run_sql_readonly
  sql: SELECT p.id, p."nameFirstName", p."nameLastName", p."jobTitle",
              c.name AS company, c."addressAddressCity" AS city
       FROM person p JOIN company c ON p."companyId" = c.id
       WHERE p."prudaiMarketingSourceSystem" = 'architectenregister'
         AND c."addressAddressCity" IN ('Enschede','Hengelo','Almelo','Oldenzaal','Borne','Losser','Haaksbergen','Tubbergen','Dinkelland','Wierden','Hof van Twente','Rijssen-Holten')
         AND p."deletedAt" IS NULL AND c."deletedAt" IS NULL
       ORDER BY c."addressAddressCity", p."nameLastName"
       LIMIT 100
```

---

## ⚙️ Configuration

### Environment Variables

- `TWENTY_API_KEY` (required): Your Twenty CRM API key
- `TWENTY_BASE_URL` (optional): Twenty CRM base URL (defaults to `https://api.twenty.com`)

### Custom Fields

The server automatically discovers and supports custom fields in your Twenty CRM instance. No configuration changes needed when you add new fields.

---

## 🤝 Contributing

We welcome contributions! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

### Development

1. **Clone the repo**:
```bash
git clone https://github.com/mhenry3164/twenty-crm-mcp-server.git
cd twenty-crm-mcp-server
```

2. **Install dependencies**:
```bash
bun install
```

3. **Set up environment variables**:
```bash
cp .env.example .env
# Edit .env with your API key
```

4. **Type-check, test, smoke**:
```bash
bun run typecheck   # tsc --noEmit (strict)
bun test            # unit + E2E
bun run smoke       # end-to-end MCP stdio smoke
```

---

## 🐛 Troubleshooting

### Common Issues

**Authentication Error**: Verify your API key is correct and has appropriate permissions.

**Connection Failed**: Check that your `TWENTY_BASE_URL` is correct (especially for self-hosted instances).

**Field Not Found**: The server automatically discovers fields. If you're getting field errors, try getting the metadata first: *"Show me the available fields for people"*

---

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

---

## 🙏 Acknowledgments

- [Twenty CRM](https://twenty.com) for providing an excellent open-source CRM
- [Anthropic](https://anthropic.com) for the Model Context Protocol
- The MCP community for inspiration and examples

---

## 🔗 Links

- [Twenty CRM Documentation](https://twenty.com/developers)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Claude Desktop](https://claude.ai/desktop)

---

<div align="center">

**Made with ❤️ for the open-source community**

*⭐ Star this repo if you find it helpful!*

</div>