
TODO: make the agent ask proper questions using a tool

TODO: log daemon.log

ASK: look into the run at ~/dev/modulaser-site/.autoauto/programs/homepage-lighthouse/runs/20260408-024718 - it did not go very well. can you find out why, any potential things we can improve?

-> remove lighthouse scripts in modulaser-site and try again, should use diagnostics
-> double verify it actually used the diagnostics

TODO: allow changing config.json easily?

Manually test:
* finalize

analyze ~/dev/modulaser-v2/.autoauto/programs/e2e-render-perf - it didnt go very well, any changes we should make to autoauto?


"Working tree has uncommited changes" -> this should show the worktree name as well as a list of file changes.
Then it should show a commit, retry and quit button.
Commit should launch an agent to commit it for you. Retry just check again basically

remove max_experiments and max_turns from setup and just put it in prerun screen. use data from the previous run by defualt

TODO: auto-caffeinate macos while its running?

TODO: uncommited changes thing doesnt actually commit, does it have access to the right tools?

Finalize: in the finalize screen we should be able to do these things;
- Combine groups to one branch or multiple
- See risk assessment (as we already have)
- Remove specific experiments/commits

^ make sure that the user gets guided properly

I approved the proposed groups but it wasnt really clear what to do after this.

