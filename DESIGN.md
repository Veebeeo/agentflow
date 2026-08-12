# AgentFlow: design notes

## Schema reasoning

The data model is shaped by one question: what has to be true when two tenants
share a database and a workflow can stop halfway through for a day?

**Membership is the unit of authorization, not the user.** A role is not a
property of a person, it is a property of a `(user, organization)` pair, so
`org_members` carries the role and every permission in the system reads it from
there. An editor in Northwind carries no privileges at all in Contoso, because
the grant simply does not exist for that pair. The table has a unique constraint
on `(org_id, user_id)`, a trigger making an organization's creator its first
owner, and a trigger refusing to remove or demote the last owner.

**Enum tables rather than CHECK constraints.** `step_type`, `trigger_type`,
`run_status` and `step_run_status` are real tables with foreign keys. This costs
a join and buys two things: Hasura can traverse the relationship inside a
permission rule, and a type can carry attributes. `step_type.is_privileged` is
the one that matters, and it is the reason layer 2 is a column lookup rather
than a hardcoded list.

**Execution state is separated from definition.** `workflow_steps` is what the
user built; `step_runs` is what happened. A run therefore records its own
history rather than pointing at a definition that may have changed since. The
denormalized `org_id` on `workflow_runs`, set by a trigger rather than by the
caller, means the tenant boundary on a run cannot be spoofed by whoever started
it.

**Positions are ordinals with a deferrable unique constraint**, so reordering
steps within one transaction does not trip over itself. `conditional_branch`
targets must be strictly greater than the current position, checked at save time
and again at run time, which makes every workflow a DAG that terminates.

**Quota reservation is a single statement.** `reserve_org_quota` increments and
checks in the same UPDATE with the row locked, so two concurrent runs cannot
both observe 99 of 100 used and both proceed. Read-then-write would be a race
with real financial consequences.

---

## Two permission layers, enforced differently

The layers are not two rules of the same kind. They differ because the questions
they answer differ.

**Layer 1 is a row filter, because visibility is a property of a row.** Every
select, insert, update and delete permission on every table scopes through
membership:

```yaml
filter:
  organization:
    members:
      user_id: { _eq: X-Hasura-User-Id }
```

Hasura compiles this into the SQL WHERE clause, which means it applies
identically to queries, mutations and subscriptions. A subscription on another
tenant's run does not error; it opens successfully and stays empty. That is the
same code path, not a second implementation that has to be kept in step.

The most important permission here is one that does not exist. `workflow_runs`
and `step_runs` have no insert, update or delete permission for any user role.
Those mutations are absent from a user's schema entirely, so there is no
sequence of GraphQL calls that fabricates a run or marks a failed one succeeded.

**Layer 2 splits, because "may you do this" is two different questions.**

For privileged step types, it is still a row question and stays declarative. The
rule reads `is_privileged` through a relationship rather than naming step types:

```yaml
check:
  _or:
    - step_type_row: { is_privileged: { _eq: false } }
    - workflow:
        organization:
          members:
            _and:
              - user_id: { _eq: X-Hasura-User-Id }
              - role: { _eq: owner }
```

Add a dangerous step type later, flag the column, and the rule already covers
it. The same rule exists again as a Postgres trigger, `guard_privileged_step`,
because Hasura is not the only thing that can write to that table and a
compromised API layer should not be able to create one either.

For clearing an approval gate, no row filter can express it. The question is
whether *this run, right now, in this state* may be advanced by *this caller*,
and that is a decision about mid-execution state rather than about whether a row
is visible. So it lives in the `approveStep` Action handler, which re-derives
the caller's identity from `session_variables` and their role from a fresh
database query. The rule that makes this safe: the handler never reads who the
caller is from the request body. Hasura puts the verified identity in
`session_variables`, and that is the only place it is read from.

A viewer calling `approveStep` directly with a crafted payload therefore gets
exactly as far as clicking a button they cannot see.

---

## How the approval gate pauses and resumes

The obvious implementation of a workflow engine is a loop inside the mutation
that started it. It works in a demo and breaks on contact with reality, because
three separate things need the same escape hatch: an approval gate stops the run
for hours, a serverless function is killed at its timeout mid-chain, and the
executor sometimes crashes.

So the engine is built around one operation:

> `advanceRun(runId)` moves this run as far forward as it safely can, then
> leaves it in a state something else can resume from.

Every stopping condition is the same stopping condition. There is no special
case for approvals.

**Starting a run does not execute it.** `triggerWorkflowRun` validates the
caller, reserves quota, inserts a `workflow_runs` row and returns. A Hasura
event trigger on that insert hands off to the executor, so a workflow with four
slow LLM calls never blocks the caller's mutation and the UI gets a run id
immediately.

**Runs are claimed before they are touched.** `claim_workflow_run` is a single
conditional UPDATE that succeeds only if the run is unclaimed or its lease has
expired. Two executors racing means one gets nothing back and goes home. This is
also why crash recovery is free: a dead executor's lease simply expires, and the
cron scheduler picks the run back up.

**Reaching an `approval_gate` writes `paused` and releases the lease.** Nothing
after the gate has executed, and the run row records the position it stopped at.
`approval_gate` is deliberately absent from the step registry, because it is not
a step that executes, it is a step that stops the engine.

**Approval is a separate Action, not a resumption.** `approveStep` checks the
caller's role, marks the step run approved with `approved_by` and `approved_at`,
and then schedules a Hasura one-off event pointing back at the executor. Hasura
owns delivery and retries. The alternative, an in-process timer, dies with the
process.

**The continuation is the same entry point as everything else.**
`/execute-run` accepts a direct call, an event trigger payload, or a scheduled
event payload, and does the same thing with all three: claim the run, advance
from `next_position`, stop when it must. Which is why the same code that handles
an approval also handles a timeout and a crash.

Throughout, the UI is not polling. Two GraphQL subscriptions are open on the run
view, one on `step_runs` filtered to the run and one on the run header. Every
state the executor writes arrives over those sockets, which is why the paused
state appears the instant the engine stops and the rest of the rail fills in on
its own after an approval.
