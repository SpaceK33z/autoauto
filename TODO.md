TODO: allow to delete entire run

ASK: it should save all sessions with detail, so I can debug and improve -> might already have this as .ndjson somewhere

TODO: don't ask "measure.sh" to be locked, it should always be locked

TODO add somewhere: we also want to make a list of good examples
like lighthouse score, which tools to use etc. etc.

TODO: also keep track of tokens consumer per run
-> show this somewhere as well

TODO: before running experiment, if we detect its never been run before, recommend to start with small max_experiments

TODO: stop after x times no improvements or continue

TODO: use articles to come up with good skills / good guidance

TODO: make the agent ask proper questions using a tool

TODO: "Working tree has uncommited changes." -> this is because it inserts .autoauto itself into gitignore

TODO: add support for worktrees

ASK: As a user, I want to be able to change the amount of experiments or other details DURING the run. /grill-me

ASK: Look at the IDEA.md and our implementation. Anything inconsistent? There might be some changes 
ASK: make sure our IDEA.md is up to date compared to the codebase.
ASK: Based on what we have, create a proper README.md file so it's easy for people to understand when to use this, why and how.
ASK: in the README, explain why not simply use some autoresearch skills, explain what this offers

ASK: make sure that docs/ is up to date compared to our codebase.

ASK: gather best practices about Bun, use exa and web search. then, look at our usage of bun in the codebase

TODO: log daemon.log

----

  1. Ideas backlog (Piana pattern) -- Not implemented

  This is the big gap. Currently, agents have no way to write down:
  - What they tried and WHY it didn't work
  - What they think should be tried next
  - Accumulated reasoning/learnings

  Right now the only "memory" is results.tsv descriptions + discarded diffs. That captures what changed but not why it failed or what to try next. The articles call the ideas backlog "the
  killer feature" because it prevents agents from retrying failed approaches and preserves reasoning across the fresh-context-per-experiment boundary.