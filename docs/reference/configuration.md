# Configuration

| Variable | Flag | Default |
| --- | --- | --- |
| `AGENT_AUTH_ADMIN_TOKEN` | `--admin-token` | Required, 16 characters or more |
| `AGENT_AUTH_HOST` | `--host` | `127.0.0.1` |
| `AGENT_AUTH_PORT` | `--port` | `8787` |
| `AGENT_AUTH_DB` | `--db` | `./data/agent-auth.db` |
| `AGENT_AUTH_KEY` | `--key` | `./data/signing-key.pem`, created with mode `0600` on first start |
| `AGENT_AUTH_ISSUER` | `--issuer` | The URL the server listens on |
| `AGENT_AUTH_URL` | `--url` | `http://127.0.0.1:8787`, used by CLI commands |
| `AGENT_AUTH_TOKEN` | `--token` | Agent token for CLI commands; also accepts `@file` or `-` for stdin |

Run `agent-auth --help` for every command and option.
