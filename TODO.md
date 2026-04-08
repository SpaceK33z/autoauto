TODO: don't ask "measure.sh" to be locked, it should always be locked

TODO: before running experiment, if we detect its never been run before, recommend to start with small max_experiments

TODO: make the agent ask proper questions using a tool

ASK: Based on what we have, create a proper README.md file so it's easy for people to understand when to use this, why and how.
ASK: in the README, explain why not simply use some autoresearch skills, explain what this offers

TODO: log daemon.log


ASK: When exactly do we use the finalize step? Should we perhaps make this more clear to the user, any ideas?

---

 1. daemon-client.ts does 3 things — spawning, file watching, and state reconstruction. These
   are tightly coupled today but would benefit from splitting if any of them grow (especially
  the watcher, which has its own lifecycle).


  . run.ts mixes state I/O with orchestration — startRun() does low-level file writes and
  high-level flow (check clean tree → branch → lock → baseline → write state). Extracting the
  orchestration into a run-setup.ts or similar would clarify that run.ts is "state
  persistence" vs "run bootstrap."

---

Next up:
* see how many things it can identify on the tango-web codebase
  * does it see automatix? if not we need to improve prompt
  * ehh should also be some other things it should spot