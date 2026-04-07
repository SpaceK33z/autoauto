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

ASK: collect research (exa search) about best practices for prompts. Do our agent prompts work well for this? Do note they go to coding agents (claude agent sdk etc)
-> should we use progresive disclosure? I might want to add more data soon like examples etc, but I worry the system prompt will be too heavy

ASK: make it possible to delete entire programs

---

Next up:
* see how many things it can identify on the tango-web codebase
  * does it see automatix? if not we need to improve prompt
  * ehh should also be some other things it should spot