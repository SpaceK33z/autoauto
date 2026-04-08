
TODO: don't ask "measure.sh" to be locked, it should always be locked

TODO: make the agent ask proper questions using a tool

TODO: log daemon.log

TODO: make sure that we can capture an entire setup conversation, and then we can judge it.
-> might want to setup an eval framework for this

ASK: When exactly do we use the finalize step? Should we perhaps make this more clear to the user, any ideas?

ASK: look into the run at ~/dev/modulaser-site/.autoauto/programs/homepage-lighthouse/runs/20260408-024718 - it did not go very well. can you find out why, any potential things we can improve?

-> remove lighthouse scripts in modulaser-site and try again, should use diagnostics
-> double verify it actually used the diagnostics

TODO: queueing, do a run when another run is finished

TODO: with the markdown rendering, i think we don't even do anything special for a header like # or ## is that possible? can we make it at least bold

TODO: finalize crash

TODO: use this fancy skill to generate graph

TODO: create a LITERATURE.md doc that references all the knowledge we implemented in prompts or code with quotes, and refers to sources - also refer to this in README.md

TODO: enhance finalize: have it identify risky changes (specifically user-facing) and make it easy to revert

TODO: finalize should work on multiple runs not just one (how does the other one do it?)

TODO: add way for notifications, have a free form field + test it + support templating

TODO: add gif/video

---

Next up:
* see how many things it can identify on the tango-web codebase
  * does it see automatix? if not we need to improve prompt
  * ehh should also be some other things it should spot
* run it on modulaser-v2, focus on performance