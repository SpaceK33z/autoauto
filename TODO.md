TODO: don't ask "measure.sh" to be locked, it should always be locked

ASK: question, during the setup do we really guide the user during every decision? Does it explicitly ask e.g. if the constraints are good (what to edit / not to edit?)

TODO: before running experiment, if we detect its never been run before, recommend to start with small max_experiments

TODO: make the agent ask proper questions using a tool

TODO: "Working tree has uncommited changes." -> this is because it inserts .autoauto itself into gitignore

ASK: Based on what we have, create a proper README.md file so it's easy for people to understand when to use this, why and how.
ASK: in the README, explain why not simply use some autoresearch skills, explain what this offers

ASK: make sure that docs/ is up to date compared to our codebase.

TODO: log daemon.log

ASK: from a higher level, do we have clean separation of concerns? Any higher level improvements to make?

ASK: When exactly do we use the finalize step? Should we perhaps make this more clear to the user, any ideas?

ASK: Some alternatives have a Simplicity criterion as a keep reason - do some research with the articles / references - should we also implement that? Come up with a proposal if so

ASK: for the first setup, I'd like to guide the user through selecting a model etc that works. Basically the settings page. /grill-me

---

OpenCode support
Codex SDK


Next up:
* see how many things it can identify on the tango-web codebase
  * does it see automatix? if not we need to improve prompt
  * ehh should also be some other things it should spot