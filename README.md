# google-task-api-connector

A remote [MCP](https://modelcontextprotocol.io) server that gives Claude access to Google Tasks. Registered as a custom connector in claude.ai, it works on every device tied to the account.

Status: functional — the OAuth flow, token handling and Tasks API calls are implemented and deployed. Not yet exercised against a real Google consent screen end-to-end.

## Tools

`list_task_lists`, `list_tasks`, `find_tasks`, `create_task` (refuses likely duplicates unless `force=true`), `complete_task`.

## Stack

TypeScript / Node 24 · Hono · `@modelcontextprotocol/sdk` (stateless Streamable HTTP) · AWS Lambda + API Gateway + DynamoDB via SAM · OAuth 2.1 with PKCE towards the client, Google OAuth towards the API.

## Development

### Requirements

- Node 24, AWS SAM CLI (for deploy).
- **External docs and ADR list must be connected.** Architecture notes and the ADR list live outside this repo, in an Obsidian vault (`Forest/Apps/google-task-api-connector`), and are not committed. Before changing anything architectural, make sure the vault folder is accessible:
  - Claude Code: `.claude/settings.local.json` must list the vault folder in `permissions.additionalDirectories` (not committed — recreate it, or run `/add-dir <vault path>` in the session). Verify with `ls <vault path>/ADR`.
  - Manually: open the folder in Obsidian.

  Every architectural decision goes into `ADR` before or alongside the code change; `Architecture.md` is the source of truth for the overall design.

### Setup

```sh
cp .env.example .env
npm install
npm run typecheck
npm test
npm run dev        # http://localhost:3000
```

Deploy: `sam build && sam deploy --guided`. You need a Google Cloud OAuth client (Web application) with the Tasks API enabled and two Secrets Manager secrets; see `template.yaml` parameters and `.env.example` for the expected shape.

## License

MIT
