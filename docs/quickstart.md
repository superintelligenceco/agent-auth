# Quickstart

In this guide, you install agent-auth, start the server, grant an agent a scoped token and check
requests against it. It takes about five minutes.

## Install

Pick one of the following. Each installs the same CLI, which also runs the server.

::: code-group

```sh [Executable]
# Linux or macOS. Downloads the right release asset and checks its SHA-256.
curl -fsSL https://raw.githubusercontent.com/superintelligenceco/agent-auth/main/install.sh | sh
```

```sh [npm]
# Needs Node.js 20 or later.
npm install -g @superintelligenceco/agent-auth
```

```sh [Container]
export AGENT_AUTH_ADMIN_TOKEN=$(openssl rand -hex 24)
docker run -d --name agent-auth -p 127.0.0.1:8787:8787 \
  -e AGENT_AUTH_ADMIN_TOKEN -v agent-auth-data:/data \
  ghcr.io/superintelligenceco/agent-auth:latest
```

:::

On Windows, download `agent-auth-windows-x64.exe` from the
[latest release](https://github.com/superintelligenceco/agent-auth/releases/latest).

To confirm the install, run `agent-auth --version`.

## Start the server

The admin token authorizes principal actions such as creating grants. Use a random string of 16
characters or more.

```sh
export AGENT_AUTH_ADMIN_TOKEN=$(openssl rand -hex 24)
agent-auth serve &
```

The server listens on `http://127.0.0.1:8787` and stores its database and signing key in `./data`.
If you started the container instead, skip this step.

## Grant a token

A principal, `alice`, delegates three scopes to an agent, `assistant`, for one hour and at most 20
uses:

```sh
TOKEN=$(agent-auth grant --principal alice --agent assistant \
  --scope 'gmail:send to:*@acme.com' \
  --scope 'github:repo:read acme/*' \
  --scope 'payments:charge max=50USD' \
  --ttl 1h --max-uses 20 -q)
agent-auth inspect --token "$TOKEN"
```

## Check requests

A tool server asks agent-auth whether the token permits a concrete request. Exit code `0` means
allow and `3` means deny:

```console
$ agent-auth check --token "$TOKEN" --action gmail:send --param to=bob@acme.com
ALLOW             [gmail:send to:*@acme.com] (19 uses left)
$ agent-auth check --token "$TOKEN" --action payments:charge --amount 80USD
DENY              amount exceeds max=50USD (scope: payments:charge max=50USD)
```

## Hand work to a sub-agent

Derive a narrower token. A request for a broader one fails:

```sh
SUB=$(agent-auth attenuate --token "$TOKEN" --agent reviewer \
  --scope 'github:repo:read acme/widgets' --ttl 10m -q)
agent-auth attenuate --token "$SUB" --scope 'github:repo:read acme/*'
# error: scope_escalation: requested scopes exceed the parent token
```

## Revoke and audit

Revoking the root token also revokes the sub-agent's token. Then read and verify the audit log:

```sh
agent-auth revoke --token "$TOKEN"
agent-auth audit log
agent-auth audit verify
```

## Next steps

- Learn the scope grammar and the attenuation rules in [Concepts](/concepts).
- Protect your own API with the middleware in [Use it from a tool server](/tool-servers).
- See every command in the [CLI reference](/reference/cli).
