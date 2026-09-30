---
layout: home
hero:
  name: agent-auth
  text: Credentials for AI agents that you can scope, expire, revoke and audit
  tagline: A small self-hosted service, CLI and TypeScript SDK. Give an agent exactly the authority a task needs, and see everything it did with it.
  image:
    src: /demo.gif
    alt: A terminal session that grants a token, checks allowed and denied requests, and verifies the audit log
  actions:
    - theme: brand
      text: Quickstart
      link: /quickstart
    - theme: alt
      text: Concepts
      link: /concepts
    - theme: alt
      text: GitHub
      link: https://github.com/superintelligenceco/agent-auth
features:
  - title: Narrow scopes
    details: "Scopes name actions, resources, parameters and spend limits, such as gmail:send to:*@acme.com or payments:charge max=50USD."
  - title: Attenuation for sub-agents
    details: An agent can hand a sub-agent a narrower token. The service proves the child is no broader than its parent.
  - title: Revocation that cascades
    details: Revoking a token cuts off everything derived from it. Tokens also expire and can carry use limits.
  - title: Human approval
    details: Mark risky scopes approval=required, and each use waits for a person to approve that exact request.
  - title: Tamper-evident audit log
    details: Every decision lands in a hash-chained log. agent-auth audit verify finds the first altered entry.
  - title: Ships as you need it
    details: Standalone executables, a multi-arch container image and an npm package, each with provenance attestations.
---
