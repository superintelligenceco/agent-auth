# 3. Conservative scope attenuation

Status: accepted

## Context

An agent can derive a token for a sub-agent. The service must guarantee the child never permits a
request that its parent denies. Scopes use globs in resources and parameters, and an exact subset
test for two glob patterns is expensive and easy to get wrong.

## Decision

A child scope set is accepted only when every child scope is covered by a single parent scope. The
action pattern, resource glob and every parameter glob of the child must be subsets of the
parent's, a child may add parameter constraints but never drop one, an amount limit must use the
same currency and be no higher, and approval requirements carry over. The glob subset check is
conservative: it may reject a few exotic pairs where containment does hold, and it never accepts a
pair where it does not. The scope engine in `src/scope/` has no I/O.

Property-based tests with fast-check generate scopes and requests over small alphabets and assert
that an accepted child set never allows a request that its parent set denies, across chains of
attenuations. A scheduled Stryker run measures how well those tests catch changes to the engine.

## Consequences

- Soundness does not depend on the glob check being complete.
- Some valid narrowings are rejected. A caller can work around this by stating the child scope in
  the same shape as the parent's.
- Children also expire no later than their parent, carry no more uses and sit at most 8 levels
  deep by default.
