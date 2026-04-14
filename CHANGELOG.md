# Changelog

## [1.8.0](https://github.com/SpaceK33z/autoauto/compare/v1.7.0...v1.8.0) (2026-04-14)


### Features

* **sandbox:** forward agent configs and subscription auth into containers ([#43](https://github.com/SpaceK33z/autoauto/issues/43)) ([e299b69](https://github.com/SpaceK33z/autoauto/commit/e299b69fc4d411e7b3a7c1eacae71757661427ba))
* **sandbox:** sync agent config into remote containers ([#45](https://github.com/SpaceK33z/autoauto/issues/45)) ([acf2f24](https://github.com/SpaceK33z/autoauto/commit/acf2f244774fd4a7c2fb6766ceb4340f12c90a44))

## [1.7.0](https://github.com/SpaceK33z/autoauto/compare/v1.6.0...v1.7.0) (2026-04-13)


### Features

* **experiment:** diagnose silent no-commit outcomes ([c84031c](https://github.com/SpaceK33z/autoauto/commit/c84031cec408300cf395f51874f12ab5a4aa01d7))
* **mcp:** add first-time setup guidance for unconfigured projects ([49d7698](https://github.com/SpaceK33z/autoauto/commit/49d769857f5f9fa3c0ec7a7b1982075fe1ff3ec6))
* **sandbox:** remote container execution via Modal ([#40](https://github.com/SpaceK33z/autoauto/issues/40)) ([afd6571](https://github.com/SpaceK33z/autoauto/commit/afd6571cc33ed5d3a41f62cfc315afab8ab508ad))


### Bug Fixes

* **agent:** validate model compatibility before starting runs ([8da8d89](https://github.com/SpaceK33z/autoauto/commit/8da8d8924bf4da45bf98f61e2d85319f1ac49467))
* **home:** include onPanelChange in useEffect dependency array ([888655f](https://github.com/SpaceK33z/autoauto/commit/888655fd1b625ffb194c508d629b8b294a5b3991))
* **mcp:** validate model compatibility in set_config before saving ([bbc523b](https://github.com/SpaceK33z/autoauto/commit/bbc523b4d1f2f1fdc6ae0be640049518f04bdf68))
* **model:** include available models in opencode format error message ([20b330a](https://github.com/SpaceK33z/autoauto/commit/20b330a13aaa2dd72ccfddf3956aa32aebb9cd5e))
* **setup:** lower default max_experiments to 10 for new programs ([34c8fef](https://github.com/SpaceK33z/autoauto/commit/34c8fefbeea7e80bd4e81419981102512060062e)), closes [#39](https://github.com/SpaceK33z/autoauto/issues/39)
* **test:** stabilize concurrent e2e runs ([996f445](https://github.com/SpaceK33z/autoauto/commit/996f4458c0d41d50cf683035ce91875d49e6c5ff))

## [1.6.0](https://github.com/SpaceK33z/autoauto/compare/v1.5.0...v1.6.0) (2026-04-12)


### Features

* add Task tool to experiment agent for parallel subagent research ([4c1779c](https://github.com/SpaceK33z/autoauto/commit/4c1779c509887eae2c60dc6f02f85a693f1ea877))
* **agent-panel:** show experiment notes as styled card instead of raw XML ([a1069f5](https://github.com/SpaceK33z/autoauto/commit/a1069f5df85aa55c7026c53ea5d676c0d09e30c5))
* auto-fallback to alternate model on provider limits ([#32](https://github.com/SpaceK33z/autoauto/issues/32)) ([b98f34b](https://github.com/SpaceK33z/autoauto/commit/b98f34bff6c31b725dee6c184a723e7701665a5e))
* **execution:** filter ideas panel to selected experiment ([442f551](https://github.com/SpaceK33z/autoauto/commit/442f5513f4ad87a7f56c2a4002e467618bf489b7))
* **execution:** make narrow-mode Agent/Ideas tab titles clickable ([46ae4b7](https://github.com/SpaceK33z/autoauto/commit/46ae4b7222c27ffebf74a26460dd85706a0133fe))
* expand CLI with 6 new commands for agent-friendly control ([#30](https://github.com/SpaceK33z/autoauto/issues/30)) ([d159237](https://github.com/SpaceK33z/autoauto/commit/d1592371d588653d65bb7f3cbf509aaa493c0f16))
* **guidance:** add human steering for mid-run experiment direction ([#37](https://github.com/SpaceK33z/autoauto/issues/37)) ([a0aa923](https://github.com/SpaceK33z/autoauto/commit/a0aa923ee346c19c7d6d017ac7a74c512de9b4b3))
* **home:** add double-click to open programs and runs ([025e647](https://github.com/SpaceK33z/autoauto/commit/025e6470c5758b7d84414d7f82b64c0503edd351))
* **mcp:** add agent sessions and config tools ([#36](https://github.com/SpaceK33z/autoauto/issues/36)) ([cd9e647](https://github.com/SpaceK33z/autoauto/commit/cd9e64714952d94d3b8fe2feb75df6be3643fe94))
* **mcp:** add MCP server for external coding agents ([#35](https://github.com/SpaceK33z/autoauto/issues/35)) ([aa55e46](https://github.com/SpaceK33z/autoauto/commit/aa55e461289e7cf8be55cb63b7ce4f8fd3ca1c59))
* **mcp:** add resources for setup guide and program details ([ebc8d9d](https://github.com/SpaceK33z/autoauto/commit/ebc8d9d5685aa5ef5bc983c69a27f6fbf5e11267))
* **measure:** add Mann-Whitney U statistical significance testing ([#38](https://github.com/SpaceK33z/autoauto/issues/38)) ([b363c39](https://github.com/SpaceK33z/autoauto/commit/b363c39b56426e61f7bc43ecc4da6ee601aef22c))
* proactive quota usage warnings from Claude SDK rate limit events ([#34](https://github.com/SpaceK33z/autoauto/issues/34)) ([a62bb98](https://github.com/SpaceK33z/autoauto/commit/a62bb9834c41d5c00da1ce1d4232071ef3f4bb24))
* **ui:** add hint prop to CycleField component ([1454385](https://github.com/SpaceK33z/autoauto/commit/14543854b3e5e164eb108adcaaa1425d1d1ff209))


### Bug Fixes

* abort active run when deleting its queue entry ([e7353d8](https://github.com/SpaceK33z/autoauto/commit/e7353d87ecb51fcaff8592d5a5fd8f0813f9e3ec))
* **app:** use q instead of Esc to quit from home screen ([e423da3](https://github.com/SpaceK33z/autoauto/commit/e423da32a3e1e9f550745b3fa4f11bd2145513ef))
* **daemon:** clean up stuck runs from crashed daemons ([a1e5e67](https://github.com/SpaceK33z/autoauto/commit/a1e5e6739dca6cc50c00d8cb6e3fbeb7e0f127f5))
* **execution:** single-click row selection with toggle to deselect ([af5ead1](https://github.com/SpaceK33z/autoauto/commit/af5ead13c8ff73da68e18d2624366e404b98852d))
* **execution:** update phase label on attach instead of staying on "Connecting..." ([d77c4de](https://github.com/SpaceK33z/autoauto/commit/d77c4de0a073119d7ed4e986b9147291cf10f8b4))
* **finalize:** handle removed worktree for queue-sourced runs ([4e3d6b7](https://github.com/SpaceK33z/autoauto/commit/4e3d6b7bdb5df57ff19b5a32195bf58ea8af5d18))
* **finalize:** teach agent to navigate worktrees when target branch is checked out elsewhere ([4bf38fe](https://github.com/SpaceK33z/autoauto/commit/4bf38fe60f9cc6b110e147bcebd0cc1afad14de0))
* **prompt:** improve experiment agent orientation and backlog awareness ([f6e38e9](https://github.com/SpaceK33z/autoauto/commit/f6e38e9260925f4fb7f1c6374d1222a0c3473239))
* **queue:** require manual start instead of auto-starting on HomeScreen mount ([2d39b89](https://github.com/SpaceK33z/autoauto/commit/2d39b8970d785298bbb39d8ecb44cce2479e13e4))
* resolve merge conflict in queue E2E tests ([43836d3](https://github.com/SpaceK33z/autoauto/commit/43836d3cd0c7df32201dd563f3d9df01bb11208b))
* surface clear error messages when daemon fails to start ([#29](https://github.com/SpaceK33z/autoauto/issues/29)) ([963aea0](https://github.com/SpaceK33z/autoauto/commit/963aea04c109cf117445e95e6ead19043ef6d232))
* treat baseline abort as clean termination instead of crash ([939736b](https://github.com/SpaceK33z/autoauto/commit/939736b8d0c03ef9252d49a00332bed1c1540f53))
* **ui:** check terminal phase when attaching to alive daemon ([152ea8d](https://github.com/SpaceK33z/autoauto/commit/152ea8d47f14a760cf17a68da7de45af1740b603))
* **ui:** remove duplicate experiment heading in detail view ([c3a96d5](https://github.com/SpaceK33z/autoauto/commit/c3a96d5121e743ab7cf88c62319af808c5fffa8e))
* **ui:** rewrite setting descriptions to communicate trade-offs ([d1d686a](https://github.com/SpaceK33z/autoauto/commit/d1d686a9061b133f9de772249db0660b0adea005))


### Performance Improvements

* **prompts:** encourage parallel tool calls in experiment agent ([072bef3](https://github.com/SpaceK33z/autoauto/commit/072bef33d53c52446305d8ea116bc685b47c2abb))

## [1.5.0](https://github.com/SpaceK33z/autoauto/compare/v1.4.0...v1.5.0) (2026-04-10)


### Features

* add --version/-v flag to CLI ([8745515](https://github.com/SpaceK33z/autoauto/commit/87455159d688e281ef66e161023ec8916e7d3bdc))
* add abort option to stop confirmation dialog ([6dedba4](https://github.com/SpaceK33z/autoauto/commit/6dedba4f63e741c9e0141891b1a4a911475a5bdb))
* add click-to-focus for all panels in execution screen ([f8dc59b](https://github.com/SpaceK33z/autoauto/commit/f8dc59bbb9641f85da3449cb648e5d8609317dcf))
* add Ctrl+D debug frame snapshot in dev mode ([b70bb59](https://github.com/SpaceK33z/autoauto/commit/b70bb595a22c3c9a00c4ef3b5f497bb05a3a6630))
* detect provider quota/rate-limit errors and stop experiment loop ([4add972](https://github.com/SpaceK33z/autoauto/commit/4add9729cf87bfae56c74f29b01386f5585e2891))
* improve setup config defaults and confirmation flow ([db5eb1e](https://github.com/SpaceK33z/autoauto/commit/db5eb1eb23b5e02dcd2b653218794eaec550c071))
* prevent macOS sleep during daemon runs via caffeinate ([4a0a1ce](https://github.com/SpaceK33z/autoauto/commit/4a0a1ceb36683a6576ff52af0a3626ec3dc5b6b0))
* redesign home screen layout with runs on top and mouse selection ([aaaf19e](https://github.com/SpaceK33z/autoauto/commit/aaaf19eca9229e846edeb427ba23964645424395))
* show finalization summary when viewing finalized runs ([7bc68e6](https://github.com/SpaceK33z/autoauto/commit/7bc68e6978ea7b96906a6957b89e5f7f31329c4a))
* split first-time setup into conversational and experiment agent model pickers ([17ab0b5](https://github.com/SpaceK33z/autoauto/commit/17ab0b5f8690baa9742d1d8101fed7a95af5cad9))
* surface skills/prompts as first example in setup screen ([19c8755](https://github.com/SpaceK33z/autoauto/commit/19c87552bfbb9bc08ee79872f01fafe22baec5cb))


### Bug Fixes

* exclude .autoauto-* files from dirty worktree check ([1f9b1da](https://github.com/SpaceK33z/autoauto/commit/1f9b1da70dc4a7f1f33a861663e0e7823afcced7))
* handle caffeinate spawn failures gracefully in sandboxed environments ([b0ca279](https://github.com/SpaceK33z/autoauto/commit/b0ca279a4615434ed546ca66170c3fdad3218a26))
* improve pre-run screen keybindings for start and queue actions ([4fb6a81](https://github.com/SpaceK33z/autoauto/commit/4fb6a813facdc211b973b676c51493414c4804a7))
* install cross-platform native deps for darwin-x64 release build ([828441b](https://github.com/SpaceK33z/autoauto/commit/828441bb8aed8d5fd312cc39b67cd2ea5c4e9992))
* prevent flex layout overflow with explicit min dimensions and row heights ([a886caf](https://github.com/SpaceK33z/autoauto/commit/a886cafe424b490dfdbf1f70db03fa2b642bc97b))
* resolve 9 failing CI tests ([491b534](https://github.com/SpaceK33z/autoauto/commit/491b5340be3e1c1420491d34bf7f42661546a542))
* sanitize ANSI sequences and control chars in table cell formatting ([1529193](https://github.com/SpaceK33z/autoauto/commit/1529193cd394b78606e5590c5b88fd24670210c3))
* show phase-appropriate keyboard shortcuts on execution screen ([0ee1803](https://github.com/SpaceK33z/autoauto/commit/0ee1803160ddab129716bb9b74878ef2be6c757a))

## [1.4.0](https://github.com/SpaceK33z/autoauto/compare/v1.3.0...v1.4.0) (2026-04-09)


### Features

* add queue management CLI commands ([#21](https://github.com/SpaceK33z/autoauto/issues/21)) ([60ba2eb](https://github.com/SpaceK33z/autoauto/commit/60ba2eba416dcf4015869c31f128fc50142477d2))
* codex provider cost estimation from config and token pricing ([d15caa5](https://github.com/SpaceK33z/autoauto/commit/d15caa50ea55c2b5b3759caa84fd4ed6505ed119))
* dedicated UI for dirty working tree with agent-powered commit ([4d1fadc](https://github.com/SpaceK33z/autoauto/commit/4d1fadc8c4e690ffe71a7c9f5fa17e4df9ab898a))
* keep_simplifications toggle in pre-run screen ([59192e0](https://github.com/SpaceK33z/autoauto/commit/59192e0b85c29b2ccf660a545936b2174ed0cccc))
* opencode provider child session cost aggregation ([fa47719](https://github.com/SpaceK33z/autoauto/commit/fa47719d68e5954bccddcfc17055d7684ee4f214))
* redesign finalize as conversational multi-turn chat ([#25](https://github.com/SpaceK33z/autoauto/issues/25)) ([cdf808e](https://github.com/SpaceK33z/autoauto/commit/cdf808e8461ff9803e24ab344674de06cf7156d0))
* show current branch name on dirty tree prompt ([d2697a5](https://github.com/SpaceK33z/autoauto/commit/d2697a59cbf935d68aa2b7ff7b16ae1d00a26ef1))
* surface turn budget to experiment agents to prevent analysis paralysis ([584ebcf](https://github.com/SpaceK33z/autoauto/commit/584ebcfc9b4e958c364c21d963db5fe788728ef0))


### Bug Fixes

* clean up update draft when exiting via PostUpdatePrompt ([e334128](https://github.com/SpaceK33z/autoauto/commit/e33412801cfac08554ae1e6f2454fd9b46d6bc1d))
* codex sandbox mode blocks git commands in dirty tree commit agent ([5e961a0](https://github.com/SpaceK33z/autoauto/commit/5e961a031dc59541cec6bf22d5fd2a47a9c223f9))
* update pre-run E2E tests for budget cap field navigation ([1c224bf](https://github.com/SpaceK33z/autoauto/commit/1c224bf002df8c6cfd3178a99552a65294ac7d1a))

## [1.3.0](https://github.com/SpaceK33z/autoauto/compare/v1.2.0...v1.3.0) (2026-04-09)


### Features

* add interactive finalize review with approve/refine flow ([aeaabfd](https://github.com/SpaceK33z/autoauto/commit/aeaabfdb0e643b0e69a8e876c518561e1f52f22d))
* add notification support on run complete ([2effcb7](https://github.com/SpaceK33z/autoauto/commit/2effcb7c5c0ef9c45b2a5a0ba119bea392c05ed6)), closes [#9](https://github.com/SpaceK33z/autoauto/issues/9)
* carry forward previous run context into new experiments ([#17](https://github.com/SpaceK33z/autoauto/issues/17)) ([7500f6f](https://github.com/SpaceK33z/autoauto/commit/7500f6ff05ee2ceec5c089dacb21ae5608c5f9b8))
* include termination reason in carry-forward context ([71383ba](https://github.com/SpaceK33z/autoauto/commit/71383baa8a1a47b7529afe317bef23eb66306d6e))
* persist setup drafts and resume sessions on return ([f12fff1](https://github.com/SpaceK33z/autoauto/commit/f12fff17c5ffd80c8e0379b7ad44e781ac649971)), closes [#7](https://github.com/SpaceK33z/autoauto/issues/7)
* sequential run queue for overnight batch execution ([#19](https://github.com/SpaceK33z/autoauto/issues/19)) ([08e0570](https://github.com/SpaceK33z/autoauto/commit/08e05706a804b16a4c3380b39478ff9e8d75a152))
* verify results — re-run measurements after run completes ([#13](https://github.com/SpaceK33z/autoauto/issues/13)) ([7af8eef](https://github.com/SpaceK33z/autoauto/commit/7af8eefc1999c9e2c6722b056a0b03beb80f0c42))


### Bug Fixes

* add animated spinner indicators during active run phases ([404f17c](https://github.com/SpaceK33z/autoauto/commit/404f17c2d72c330e46384ba05763e3d6a9b791dd))
* clean up setup draft when program was successfully created ([2cac919](https://github.com/SpaceK33z/autoauto/commit/2cac919fb355a28752eb2caaf31640b5ad06a218))
* merge main, update tests for verify feature and revised FinalizeApproval ([0a0b447](https://github.com/SpaceK33z/autoauto/commit/0a0b447f2376dcdaa397e58e9e3f5df254bb5545))
* remove maxTurns limit from setup phase chat ([570dd58](https://github.com/SpaceK33z/autoauto/commit/570dd58e5f69c9956f03dc9b371a8e7118ee3a93))
* rename Abandon to Done in run complete prompt ([11627d0](https://github.com/SpaceK33z/autoauto/commit/11627d0d2b8c1a015445e16eb201c8342e98fb75))
* resolve FinalizeApproval rendering crash and fix E2E tests ([8a96e29](https://github.com/SpaceK33z/autoauto/commit/8a96e29aa166db41363ed9e73fc63b49b617d645))
* show streaming indicator during multi-turn agent activity ([20efb04](https://github.com/SpaceK33z/autoauto/commit/20efb04cfc8f00ebcc45f5cf559130b71cfd54d5))
* use macos-latest for darwin-x64 build and allow partial uploads ([c4d778b](https://github.com/SpaceK33z/autoauto/commit/c4d778b9c0b1d401478e5c9cee4cc31c6145090c))

## [1.2.0](https://github.com/SpaceK33z/autoauto/compare/v1.1.0...v1.2.0) (2026-04-08)


### Features

* add cleanup agent, evaluator snapshots, and compact TUI layout ([1f6cbad](https://github.com/SpaceK33z/autoauto/commit/1f6cbadef70c8302d5f4d1053b95291b5a37f4f6))
* add clipboard copy-on-select via OSC 52 ([05b73c4](https://github.com/SpaceK33z/autoauto/commit/05b73c4cff545d80ec8177f84e93fcbd5fc3d505))
* add codex agent provider ([d86d8d9](https://github.com/SpaceK33z/autoauto/commit/d86d8d9a44fe9b1db85dcba84c4caf221d77851e))
* add column allocation utilities and edge-case fixes ([f27466b](https://github.com/SpaceK33z/autoauto/commit/f27466b62d474d79224acc01e646610d20010e28))
* add compact tab bar for small terminal windows ([ef29916](https://github.com/SpaceK33z/autoauto/commit/ef29916b9fb11039976a173b9185afa347907bfa))
* add daemon-backed experiment runs ([bf313c7](https://github.com/SpaceK33z/autoauto/commit/bf313c79a0fc0cfaceabad7e20954ff5bffb773f))
* add duplicate program detection and improve setup prompts ([8a45afe](https://github.com/SpaceK33z/autoauto/commit/8a45afe12b00a4ba52fbdfd55a76b49270437014))
* add escalating exploration directives to escape local optima ([3b47ac3](https://github.com/SpaceK33z/autoauto/commit/3b47ac3c488a53e303afd08d3efebd520f1b0eab))
* add experiment loop, context packets, and agent spawning for autoresearch ([736e686](https://github.com/SpaceK33z/autoauto/commit/736e6861ebdc1e8ee66efbed89bc82bf4789066c))
* add first-time setup screen for provider/model selection ([c1e8439](https://github.com/SpaceK33z/autoauto/commit/c1e8439eb564dcaad361434979914eec59f1f576))
* add formatShellError utility for better shell error messages ([2ad3ef0](https://github.com/SpaceK33z/autoauto/commit/2ad3ef09f4df227d85f4269c0182e207e7b5a4ae))
* add headless CLI subcommands for Claude Code integration ([0d6e1a0](https://github.com/SpaceK33z/autoauto/commit/0d6e1a0d0cb4a6fa9cecd88c898a209689dab74f))
* add ideas backlog toggle ([6638034](https://github.com/SpaceK33z/autoauto/commit/6638034f036d629767442592e466ef1cb58887c6))
* add ideas.md panel to execution screen with live updates ([b9b3734](https://github.com/SpaceK33z/autoauto/commit/b9b37345f37b2912dbc26f8dce6c8c95964f6bbd))
* add inline timestamps and tool events to agent panel ([7ae96a8](https://github.com/SpaceK33z/autoauto/commit/7ae96a86431689847a8c4edd311f5273e2305166))
* add measurement diagnostics sidecar file support ([0257b8c](https://github.com/SpaceK33z/autoauto/commit/0257b8c133a6b21ceb9fbf2918562a69ef484363))
* add measurement validation with variance analysis and stability assessment ([33d2190](https://github.com/SpaceK33z/autoauto/commit/33d2190701f3371bc0e22422034bdb5b36113f77))
* add mid-run settings overlay for max experiments ([f6a19c4](https://github.com/SpaceK33z/autoauto/commit/f6a19c42be99c3abb23eb616fa432b72cde0a3a2))
* add model configuration settings and auth check on startup ([8e47ccf](https://github.com/SpaceK33z/autoauto/commit/8e47ccf9e23f0e210a1b3a1121e29ce3d387e73f))
* add navigable results table and experiment detail view ([fad0596](https://github.com/SpaceK33z/autoauto/commit/fad05965407d7d71819adc1794d2ac4a949779ae))
* add optional in-place run mode (skip worktree) ([0d0d6dd](https://github.com/SpaceK33z/autoauto/commit/0d0d6dddc55fb962533169b7ed9204f3a7079c32))
* add permission bypass, tool status display, and autoresearch expertise to setup agent ([6ff2376](https://github.com/SpaceK33z/autoauto/commit/6ff237666925a1fcd37e9a4ac41ecf7e6ce7e426))
* add pre-run config screen with time estimates and model overrides ([4618069](https://github.com/SpaceK33z/autoauto/commit/4618069400cdf0190e9c236623578cd27dde2f8f))
* add program artifact generation with Write/Edit tools and user review flow ([b54fd7d](https://github.com/SpaceK33z/autoauto/commit/b54fd7d9b954fbb9f444150f225ff5097241cff0))
* add program deletion with cascading run cleanup ([0e9f76a](https://github.com/SpaceK33z/autoauto/commit/0e9f76aa40bac7b6c0286b3b7ed639bf7a9b6294))
* add program management and project root utilities ([6a9fe19](https://github.com/SpaceK33z/autoauto/commit/6a9fe19dbfab8f2023cf4abde2385e9804e6e00b))
* add program update mode with auto-analysis of previous runs ([c3a1ded](https://github.com/SpaceK33z/autoauto/commit/c3a1dedbb215ef09d1076bba3ffc0a6ee307fa16))
* add provider-specific model selection ([3ed490f](https://github.com/SpaceK33z/autoauto/commit/3ed490f1be51a5bf98a3f7344053294d734b1a42))
* add push-based async iterable utility for SDK streaming ([7544a39](https://github.com/SpaceK33z/autoauto/commit/7544a39113b0834441bb91be7e9dcd885d087739))
* add re-baseline logic after keeps and consecutive discards ([649422b](https://github.com/SpaceK33z/autoauto/commit/649422b8dbb651c0c8a44ca1a713739220bedbbc))
* add results reading, run listing, events logging, and cost tracking ([d5db6be](https://github.com/SpaceK33z/autoauto/commit/d5db6be5d74b383e65fa91618cbe93dfe8eca45a))
* add run deletion from home screen ([8ceb4fd](https://github.com/SpaceK33z/autoauto/commit/8ceb4fd25f7d19c60a75d7b24c95e113a83de7f6))
* add run lifecycle, measurement, and git utilities for experiment loop ([bf36174](https://github.com/SpaceK33z/autoauto/commit/bf3617485625a3c1d93615fd1e894e704325aaef))
* add run termination, abort handling, and execution screen ([903ce72](https://github.com/SpaceK33z/autoauto/commit/903ce72b6928ce9be966f3cb34ab2ba36f46ed8f))
* add screen navigation with home and setup screens ([0833253](https://github.com/SpaceK33z/autoauto/commit/08332535eb016d11976ded4f1c8159b23e882452))
* add secondary metrics support (advisory, non-gating) ([e610523](https://github.com/SpaceK33z/autoauto/commit/e6105235c0927f51a9f6eb1a21c35d136ec37d00))
* add setup agent with system prompt, tools, and ideation mode ([16b94ae](https://github.com/SpaceK33z/autoauto/commit/16b94ae1268074199d0c79571087654436059dcb))
* add setup mode chooser with codebase analysis option ([db1d943](https://github.com/SpaceK33z/autoauto/commit/db1d9437c13afcbed8a3933c291143f48f7df5de))
* add simplicity criterion — auto-keep experiments that simplify code ([76d830e](https://github.com/SpaceK33z/autoauto/commit/76d830eaef5bb57b9584fdbea8a9df45c1f73c97))
* add tool status parsing, phase-aware indicators, and detach ([dfd6893](https://github.com/SpaceK33z/autoauto/commit/dfd6893de47bf2e16f868be209be25963da6592c))
* add TUI execution dashboard with stats, results table, and agent panel ([d46da14](https://github.com/SpaceK33z/autoauto/commit/d46da149801dfe57e943c2db0c6fd07dc75517e0))
* allow deferred finalize on completed runs ([39b3532](https://github.com/SpaceK33z/autoauto/commit/39b3532a6488c19ae5ec054ed37eb06bf3dda563))
* initial project scaffolding with OpenTUI + Claude Agent SDK ([2011300](https://github.com/SpaceK33z/autoauto/commit/201130012fec2585384e272d4757734a3a061615))
* make agent max_turns configurable per-program (default 50) ([2a84da0](https://github.com/SpaceK33z/autoauto/commit/2a84da08aa9cc8f5a4dbcd0a1e78dc495a50789c))
* make max_experiments required instead of optional ([849cb2b](https://github.com/SpaceK33z/autoauto/commit/849cb2bc44370534da7261628989292fd36b691d))
* redesign home screen with programs and runs panels ([29b6771](https://github.com/SpaceK33z/autoauto/commit/29b67713b3f64c65f0784db101fa3f395197bf17))
* render agent responses as markdown with syntax highlighting ([128b796](https://github.com/SpaceK33z/autoauto/commit/128b796d368543fe1c05a2a5762d8b8c0717fa34))
* replace cleanup with finalize — group experiments into independent branches ([b723a6f](https://github.com/SpaceK33z/autoauto/commit/b723a6f17132e804a986327e3a941083b0897a93))
* replace input with multiline textarea and auto-focus on typing ([be02739](https://github.com/SpaceK33z/autoauto/commit/be027393505077d6914bf42db252d7d9b79a8698))
* separate build from measurement, add animated tool status, and improve setup UX ([fc9b6f7](https://github.com/SpaceK33z/autoauto/commit/fc9b6f7884df7c96d07416224d72d7bccc90b5e8))
* show model label in setup/update chat title ([3241c97](https://github.com/SpaceK33z/autoauto/commit/3241c972528160ed39af528ce7e2fbc33ba1f57e))
* sort programs by most recently used run on home screen ([f4a7e97](https://github.com/SpaceK33z/autoauto/commit/f4a7e9719ccebf1e01bcb7d79949bc57ffad4b7f))


### Bug Fixes

* add contextual guidance for direct setup mode ([0d44a84](https://github.com/SpaceK33z/autoauto/commit/0d44a843418115d6b5afcca1d536bc2f630fad8b))
* add flexGrow to select components so items render visibly ([4eacda4](https://github.com/SpaceK33z/autoauto/commit/4eacda4c47f7e2fd033f6e91ab1f54c050497298))
* add missing maybeRebaseline call after no_commit/agent_error outcomes ([06c9eeb](https://github.com/SpaceK33z/autoauto/commit/06c9eeb267823f79f3af0d6cb2829d26bcf09ba1))
* apply OpenTUI best practices across TUI components ([0d13b06](https://github.com/SpaceK33z/autoauto/commit/0d13b0658585638e2d752586409bfd52d93f6bb5))
* auto-stage .gitignore after adding .autoauto entry ([fe5b5f1](https://github.com/SpaceK33z/autoauto/commit/fe5b5f1f7b1568f7630e0165151eb3b12711aa89))
* daemon agent provider init, stats header emoji width glitch, mktemp macOS guidance ([811efed](https://github.com/SpaceK33z/autoauto/commit/811efed999af20056095398eb6a33270e5eae7a8))
* enable release-please labeling for proper release creation ([5ad57c6](https://github.com/SpaceK33z/autoauto/commit/5ad57c61a82020699ac5c667cf4882e2f482e8c4))
* improve tool event display with abbreviated paths ([f957fe1](https://github.com/SpaceK33z/autoauto/commit/f957fe1598761f2bf174e1dfdddece0e7a57401a))
* kill child processes on ralph.sh exit to prevent orphaned claude sessions ([854d788](https://github.com/SpaceK33z/autoauto/commit/854d7883d140d106f3e0d37b8155291d45d0f869))
* navigate to setup screen after first-time configuration ([68d896c](https://github.com/SpaceK33z/autoauto/commit/68d896c538c4c7930f58d8f68e162894cea228a5))
* poll stream file in daemon watcher for macOS reliability ([cfd9f72](https://github.com/SpaceK33z/autoauto/commit/cfd9f7206238f56cf82d42033ded7dad94ff9179))
* **prompts:** restrict update agent to program files, fix step numbering ([d6a2707](https://github.com/SpaceK33z/autoauto/commit/d6a2707f36682084026d6396e09e7ae8fa99b326))
* review fixes for phase-1 ([faf1043](https://github.com/SpaceK33z/autoauto/commit/faf1043ca323469d74e06ae428951322895b0110))
* setup agent noise_threshold guidance for discrete/near-ceiling metrics ([f4984e0](https://github.com/SpaceK33z/autoauto/commit/f4984e057cb0e70ac85eab3a19357ad95baf8e4b))
* **setup:** await reference file writes before rendering Chat ([053e3fa](https://github.com/SpaceK33z/autoauto/commit/053e3fab80c51640f878c54d1f55fd6bfa06df7f))
* show detailed tool status in agent panel instead of generic labels ([c2666d8](https://github.com/SpaceK33z/autoauto/commit/c2666d8db5dc21b25830b0f409f78b6f52e03341))
* show rich tool status for OpenCode provider ([d8f613d](https://github.com/SpaceK33z/autoauto/commit/d8f613d18011ef13eebc80707ee6e2b53623e6a3))
* structured secondary_values JSON, table columns, and value labeling ([d40cc24](https://github.com/SpaceK33z/autoauto/commit/d40cc241007fad85dc2f41bbae01cbe371122711))
* use select component for program list to show clear selection highlight ([3597035](https://github.com/SpaceK33z/autoauto/commit/35970358411a672bf6df6e0f2741af43d76c5290))
* wrap StatsHeader text elements in box for proper line separation ([7d4aee0](https://github.com/SpaceK33z/autoauto/commit/7d4aee031e52c5d7e8ff36a387449c39eb65f047))

## [1.1.0](https://github.com/SpaceK33z/autoauto/compare/v1.0.0...v1.1.0) (2026-04-08)


### Features

* add cleanup agent, evaluator snapshots, and compact TUI layout ([1f6cbad](https://github.com/SpaceK33z/autoauto/commit/1f6cbadef70c8302d5f4d1053b95291b5a37f4f6))
* add clipboard copy-on-select via OSC 52 ([05b73c4](https://github.com/SpaceK33z/autoauto/commit/05b73c4cff545d80ec8177f84e93fcbd5fc3d505))
* add codex agent provider ([d86d8d9](https://github.com/SpaceK33z/autoauto/commit/d86d8d9a44fe9b1db85dcba84c4caf221d77851e))
* add column allocation utilities and edge-case fixes ([f27466b](https://github.com/SpaceK33z/autoauto/commit/f27466b62d474d79224acc01e646610d20010e28))
* add compact tab bar for small terminal windows ([ef29916](https://github.com/SpaceK33z/autoauto/commit/ef29916b9fb11039976a173b9185afa347907bfa))
* add daemon-backed experiment runs ([bf313c7](https://github.com/SpaceK33z/autoauto/commit/bf313c79a0fc0cfaceabad7e20954ff5bffb773f))
* add duplicate program detection and improve setup prompts ([8a45afe](https://github.com/SpaceK33z/autoauto/commit/8a45afe12b00a4ba52fbdfd55a76b49270437014))
* add escalating exploration directives to escape local optima ([3b47ac3](https://github.com/SpaceK33z/autoauto/commit/3b47ac3c488a53e303afd08d3efebd520f1b0eab))
* add experiment loop, context packets, and agent spawning for autoresearch ([736e686](https://github.com/SpaceK33z/autoauto/commit/736e6861ebdc1e8ee66efbed89bc82bf4789066c))
* add first-time setup screen for provider/model selection ([c1e8439](https://github.com/SpaceK33z/autoauto/commit/c1e8439eb564dcaad361434979914eec59f1f576))
* add formatShellError utility for better shell error messages ([2ad3ef0](https://github.com/SpaceK33z/autoauto/commit/2ad3ef09f4df227d85f4269c0182e207e7b5a4ae))
* add headless CLI subcommands for Claude Code integration ([0d6e1a0](https://github.com/SpaceK33z/autoauto/commit/0d6e1a0d0cb4a6fa9cecd88c898a209689dab74f))
* add ideas backlog toggle ([6638034](https://github.com/SpaceK33z/autoauto/commit/6638034f036d629767442592e466ef1cb58887c6))
* add ideas.md panel to execution screen with live updates ([b9b3734](https://github.com/SpaceK33z/autoauto/commit/b9b37345f37b2912dbc26f8dce6c8c95964f6bbd))
* add inline timestamps and tool events to agent panel ([7ae96a8](https://github.com/SpaceK33z/autoauto/commit/7ae96a86431689847a8c4edd311f5273e2305166))
* add measurement diagnostics sidecar file support ([0257b8c](https://github.com/SpaceK33z/autoauto/commit/0257b8c133a6b21ceb9fbf2918562a69ef484363))
* add measurement validation with variance analysis and stability assessment ([33d2190](https://github.com/SpaceK33z/autoauto/commit/33d2190701f3371bc0e22422034bdb5b36113f77))
* add mid-run settings overlay for max experiments ([f6a19c4](https://github.com/SpaceK33z/autoauto/commit/f6a19c42be99c3abb23eb616fa432b72cde0a3a2))
* add model configuration settings and auth check on startup ([8e47ccf](https://github.com/SpaceK33z/autoauto/commit/8e47ccf9e23f0e210a1b3a1121e29ce3d387e73f))
* add navigable results table and experiment detail view ([fad0596](https://github.com/SpaceK33z/autoauto/commit/fad05965407d7d71819adc1794d2ac4a949779ae))
* add optional in-place run mode (skip worktree) ([0d0d6dd](https://github.com/SpaceK33z/autoauto/commit/0d0d6dddc55fb962533169b7ed9204f3a7079c32))
* add permission bypass, tool status display, and autoresearch expertise to setup agent ([6ff2376](https://github.com/SpaceK33z/autoauto/commit/6ff237666925a1fcd37e9a4ac41ecf7e6ce7e426))
* add pre-run config screen with time estimates and model overrides ([4618069](https://github.com/SpaceK33z/autoauto/commit/4618069400cdf0190e9c236623578cd27dde2f8f))
* add program artifact generation with Write/Edit tools and user review flow ([b54fd7d](https://github.com/SpaceK33z/autoauto/commit/b54fd7d9b954fbb9f444150f225ff5097241cff0))
* add program deletion with cascading run cleanup ([0e9f76a](https://github.com/SpaceK33z/autoauto/commit/0e9f76aa40bac7b6c0286b3b7ed639bf7a9b6294))
* add program management and project root utilities ([6a9fe19](https://github.com/SpaceK33z/autoauto/commit/6a9fe19dbfab8f2023cf4abde2385e9804e6e00b))
* add program update mode with auto-analysis of previous runs ([c3a1ded](https://github.com/SpaceK33z/autoauto/commit/c3a1dedbb215ef09d1076bba3ffc0a6ee307fa16))
* add provider-specific model selection ([3ed490f](https://github.com/SpaceK33z/autoauto/commit/3ed490f1be51a5bf98a3f7344053294d734b1a42))
* add push-based async iterable utility for SDK streaming ([7544a39](https://github.com/SpaceK33z/autoauto/commit/7544a39113b0834441bb91be7e9dcd885d087739))
* add re-baseline logic after keeps and consecutive discards ([649422b](https://github.com/SpaceK33z/autoauto/commit/649422b8dbb651c0c8a44ca1a713739220bedbbc))
* add results reading, run listing, events logging, and cost tracking ([d5db6be](https://github.com/SpaceK33z/autoauto/commit/d5db6be5d74b383e65fa91618cbe93dfe8eca45a))
* add run deletion from home screen ([8ceb4fd](https://github.com/SpaceK33z/autoauto/commit/8ceb4fd25f7d19c60a75d7b24c95e113a83de7f6))
* add run lifecycle, measurement, and git utilities for experiment loop ([bf36174](https://github.com/SpaceK33z/autoauto/commit/bf3617485625a3c1d93615fd1e894e704325aaef))
* add run termination, abort handling, and execution screen ([903ce72](https://github.com/SpaceK33z/autoauto/commit/903ce72b6928ce9be966f3cb34ab2ba36f46ed8f))
* add screen navigation with home and setup screens ([0833253](https://github.com/SpaceK33z/autoauto/commit/08332535eb016d11976ded4f1c8159b23e882452))
* add secondary metrics support (advisory, non-gating) ([e610523](https://github.com/SpaceK33z/autoauto/commit/e6105235c0927f51a9f6eb1a21c35d136ec37d00))
* add setup agent with system prompt, tools, and ideation mode ([16b94ae](https://github.com/SpaceK33z/autoauto/commit/16b94ae1268074199d0c79571087654436059dcb))
* add setup mode chooser with codebase analysis option ([db1d943](https://github.com/SpaceK33z/autoauto/commit/db1d9437c13afcbed8a3933c291143f48f7df5de))
* add simplicity criterion — auto-keep experiments that simplify code ([76d830e](https://github.com/SpaceK33z/autoauto/commit/76d830eaef5bb57b9584fdbea8a9df45c1f73c97))
* add tool status parsing, phase-aware indicators, and detach ([dfd6893](https://github.com/SpaceK33z/autoauto/commit/dfd6893de47bf2e16f868be209be25963da6592c))
* add TUI execution dashboard with stats, results table, and agent panel ([d46da14](https://github.com/SpaceK33z/autoauto/commit/d46da149801dfe57e943c2db0c6fd07dc75517e0))
* allow deferred finalize on completed runs ([39b3532](https://github.com/SpaceK33z/autoauto/commit/39b3532a6488c19ae5ec054ed37eb06bf3dda563))
* initial project scaffolding with OpenTUI + Claude Agent SDK ([2011300](https://github.com/SpaceK33z/autoauto/commit/201130012fec2585384e272d4757734a3a061615))
* make agent max_turns configurable per-program (default 50) ([2a84da0](https://github.com/SpaceK33z/autoauto/commit/2a84da08aa9cc8f5a4dbcd0a1e78dc495a50789c))
* make max_experiments required instead of optional ([849cb2b](https://github.com/SpaceK33z/autoauto/commit/849cb2bc44370534da7261628989292fd36b691d))
* redesign home screen with programs and runs panels ([29b6771](https://github.com/SpaceK33z/autoauto/commit/29b67713b3f64c65f0784db101fa3f395197bf17))
* render agent responses as markdown with syntax highlighting ([128b796](https://github.com/SpaceK33z/autoauto/commit/128b796d368543fe1c05a2a5762d8b8c0717fa34))
* replace cleanup with finalize — group experiments into independent branches ([b723a6f](https://github.com/SpaceK33z/autoauto/commit/b723a6f17132e804a986327e3a941083b0897a93))
* replace input with multiline textarea and auto-focus on typing ([be02739](https://github.com/SpaceK33z/autoauto/commit/be027393505077d6914bf42db252d7d9b79a8698))
* separate build from measurement, add animated tool status, and improve setup UX ([fc9b6f7](https://github.com/SpaceK33z/autoauto/commit/fc9b6f7884df7c96d07416224d72d7bccc90b5e8))
* show model label in setup/update chat title ([3241c97](https://github.com/SpaceK33z/autoauto/commit/3241c972528160ed39af528ce7e2fbc33ba1f57e))
* sort programs by most recently used run on home screen ([f4a7e97](https://github.com/SpaceK33z/autoauto/commit/f4a7e9719ccebf1e01bcb7d79949bc57ffad4b7f))


### Bug Fixes

* add contextual guidance for direct setup mode ([0d44a84](https://github.com/SpaceK33z/autoauto/commit/0d44a843418115d6b5afcca1d536bc2f630fad8b))
* add flexGrow to select components so items render visibly ([4eacda4](https://github.com/SpaceK33z/autoauto/commit/4eacda4c47f7e2fd033f6e91ab1f54c050497298))
* add missing maybeRebaseline call after no_commit/agent_error outcomes ([06c9eeb](https://github.com/SpaceK33z/autoauto/commit/06c9eeb267823f79f3af0d6cb2829d26bcf09ba1))
* apply OpenTUI best practices across TUI components ([0d13b06](https://github.com/SpaceK33z/autoauto/commit/0d13b0658585638e2d752586409bfd52d93f6bb5))
* auto-stage .gitignore after adding .autoauto entry ([fe5b5f1](https://github.com/SpaceK33z/autoauto/commit/fe5b5f1f7b1568f7630e0165151eb3b12711aa89))
* daemon agent provider init, stats header emoji width glitch, mktemp macOS guidance ([811efed](https://github.com/SpaceK33z/autoauto/commit/811efed999af20056095398eb6a33270e5eae7a8))
* improve tool event display with abbreviated paths ([f957fe1](https://github.com/SpaceK33z/autoauto/commit/f957fe1598761f2bf174e1dfdddece0e7a57401a))
* kill child processes on ralph.sh exit to prevent orphaned claude sessions ([854d788](https://github.com/SpaceK33z/autoauto/commit/854d7883d140d106f3e0d37b8155291d45d0f869))
* navigate to setup screen after first-time configuration ([68d896c](https://github.com/SpaceK33z/autoauto/commit/68d896c538c4c7930f58d8f68e162894cea228a5))
* poll stream file in daemon watcher for macOS reliability ([cfd9f72](https://github.com/SpaceK33z/autoauto/commit/cfd9f7206238f56cf82d42033ded7dad94ff9179))
* **prompts:** restrict update agent to program files, fix step numbering ([d6a2707](https://github.com/SpaceK33z/autoauto/commit/d6a2707f36682084026d6396e09e7ae8fa99b326))
* review fixes for phase-1 ([faf1043](https://github.com/SpaceK33z/autoauto/commit/faf1043ca323469d74e06ae428951322895b0110))
* setup agent noise_threshold guidance for discrete/near-ceiling metrics ([f4984e0](https://github.com/SpaceK33z/autoauto/commit/f4984e057cb0e70ac85eab3a19357ad95baf8e4b))
* **setup:** await reference file writes before rendering Chat ([053e3fa](https://github.com/SpaceK33z/autoauto/commit/053e3fab80c51640f878c54d1f55fd6bfa06df7f))
* show detailed tool status in agent panel instead of generic labels ([c2666d8](https://github.com/SpaceK33z/autoauto/commit/c2666d8db5dc21b25830b0f409f78b6f52e03341))
* show rich tool status for OpenCode provider ([d8f613d](https://github.com/SpaceK33z/autoauto/commit/d8f613d18011ef13eebc80707ee6e2b53623e6a3))
* structured secondary_values JSON, table columns, and value labeling ([d40cc24](https://github.com/SpaceK33z/autoauto/commit/d40cc241007fad85dc2f41bbae01cbe371122711))
* use select component for program list to show clear selection highlight ([3597035](https://github.com/SpaceK33z/autoauto/commit/35970358411a672bf6df6e0f2741af43d76c5290))
* wrap StatsHeader text elements in box for proper line separation ([7d4aee0](https://github.com/SpaceK33z/autoauto/commit/7d4aee031e52c5d7e8ff36a387449c39eb65f047))

## 1.0.0 (2026-04-08)


### Features

* add cleanup agent, evaluator snapshots, and compact TUI layout ([1f6cbad](https://github.com/SpaceK33z/autoauto/commit/1f6cbadef70c8302d5f4d1053b95291b5a37f4f6))
* add clipboard copy-on-select via OSC 52 ([05b73c4](https://github.com/SpaceK33z/autoauto/commit/05b73c4cff545d80ec8177f84e93fcbd5fc3d505))
* add codex agent provider ([d86d8d9](https://github.com/SpaceK33z/autoauto/commit/d86d8d9a44fe9b1db85dcba84c4caf221d77851e))
* add column allocation utilities and edge-case fixes ([f27466b](https://github.com/SpaceK33z/autoauto/commit/f27466b62d474d79224acc01e646610d20010e28))
* add compact tab bar for small terminal windows ([ef29916](https://github.com/SpaceK33z/autoauto/commit/ef29916b9fb11039976a173b9185afa347907bfa))
* add daemon-backed experiment runs ([bf313c7](https://github.com/SpaceK33z/autoauto/commit/bf313c79a0fc0cfaceabad7e20954ff5bffb773f))
* add duplicate program detection and improve setup prompts ([8a45afe](https://github.com/SpaceK33z/autoauto/commit/8a45afe12b00a4ba52fbdfd55a76b49270437014))
* add escalating exploration directives to escape local optima ([3b47ac3](https://github.com/SpaceK33z/autoauto/commit/3b47ac3c488a53e303afd08d3efebd520f1b0eab))
* add experiment loop, context packets, and agent spawning for autoresearch ([736e686](https://github.com/SpaceK33z/autoauto/commit/736e6861ebdc1e8ee66efbed89bc82bf4789066c))
* add first-time setup screen for provider/model selection ([c1e8439](https://github.com/SpaceK33z/autoauto/commit/c1e8439eb564dcaad361434979914eec59f1f576))
* add formatShellError utility for better shell error messages ([2ad3ef0](https://github.com/SpaceK33z/autoauto/commit/2ad3ef09f4df227d85f4269c0182e207e7b5a4ae))
* add headless CLI subcommands for Claude Code integration ([0d6e1a0](https://github.com/SpaceK33z/autoauto/commit/0d6e1a0d0cb4a6fa9cecd88c898a209689dab74f))
* add ideas backlog toggle ([6638034](https://github.com/SpaceK33z/autoauto/commit/6638034f036d629767442592e466ef1cb58887c6))
* add ideas.md panel to execution screen with live updates ([b9b3734](https://github.com/SpaceK33z/autoauto/commit/b9b37345f37b2912dbc26f8dce6c8c95964f6bbd))
* add inline timestamps and tool events to agent panel ([7ae96a8](https://github.com/SpaceK33z/autoauto/commit/7ae96a86431689847a8c4edd311f5273e2305166))
* add measurement diagnostics sidecar file support ([0257b8c](https://github.com/SpaceK33z/autoauto/commit/0257b8c133a6b21ceb9fbf2918562a69ef484363))
* add measurement validation with variance analysis and stability assessment ([33d2190](https://github.com/SpaceK33z/autoauto/commit/33d2190701f3371bc0e22422034bdb5b36113f77))
* add mid-run settings overlay for max experiments ([f6a19c4](https://github.com/SpaceK33z/autoauto/commit/f6a19c42be99c3abb23eb616fa432b72cde0a3a2))
* add model configuration settings and auth check on startup ([8e47ccf](https://github.com/SpaceK33z/autoauto/commit/8e47ccf9e23f0e210a1b3a1121e29ce3d387e73f))
* add navigable results table and experiment detail view ([fad0596](https://github.com/SpaceK33z/autoauto/commit/fad05965407d7d71819adc1794d2ac4a949779ae))
* add optional in-place run mode (skip worktree) ([0d0d6dd](https://github.com/SpaceK33z/autoauto/commit/0d0d6dddc55fb962533169b7ed9204f3a7079c32))
* add permission bypass, tool status display, and autoresearch expertise to setup agent ([6ff2376](https://github.com/SpaceK33z/autoauto/commit/6ff237666925a1fcd37e9a4ac41ecf7e6ce7e426))
* add pre-run config screen with time estimates and model overrides ([4618069](https://github.com/SpaceK33z/autoauto/commit/4618069400cdf0190e9c236623578cd27dde2f8f))
* add program artifact generation with Write/Edit tools and user review flow ([b54fd7d](https://github.com/SpaceK33z/autoauto/commit/b54fd7d9b954fbb9f444150f225ff5097241cff0))
* add program deletion with cascading run cleanup ([0e9f76a](https://github.com/SpaceK33z/autoauto/commit/0e9f76aa40bac7b6c0286b3b7ed639bf7a9b6294))
* add program management and project root utilities ([6a9fe19](https://github.com/SpaceK33z/autoauto/commit/6a9fe19dbfab8f2023cf4abde2385e9804e6e00b))
* add program update mode with auto-analysis of previous runs ([c3a1ded](https://github.com/SpaceK33z/autoauto/commit/c3a1dedbb215ef09d1076bba3ffc0a6ee307fa16))
* add provider-specific model selection ([3ed490f](https://github.com/SpaceK33z/autoauto/commit/3ed490f1be51a5bf98a3f7344053294d734b1a42))
* add push-based async iterable utility for SDK streaming ([7544a39](https://github.com/SpaceK33z/autoauto/commit/7544a39113b0834441bb91be7e9dcd885d087739))
* add re-baseline logic after keeps and consecutive discards ([649422b](https://github.com/SpaceK33z/autoauto/commit/649422b8dbb651c0c8a44ca1a713739220bedbbc))
* add results reading, run listing, events logging, and cost tracking ([d5db6be](https://github.com/SpaceK33z/autoauto/commit/d5db6be5d74b383e65fa91618cbe93dfe8eca45a))
* add run deletion from home screen ([8ceb4fd](https://github.com/SpaceK33z/autoauto/commit/8ceb4fd25f7d19c60a75d7b24c95e113a83de7f6))
* add run lifecycle, measurement, and git utilities for experiment loop ([bf36174](https://github.com/SpaceK33z/autoauto/commit/bf3617485625a3c1d93615fd1e894e704325aaef))
* add run termination, abort handling, and execution screen ([903ce72](https://github.com/SpaceK33z/autoauto/commit/903ce72b6928ce9be966f3cb34ab2ba36f46ed8f))
* add screen navigation with home and setup screens ([0833253](https://github.com/SpaceK33z/autoauto/commit/08332535eb016d11976ded4f1c8159b23e882452))
* add secondary metrics support (advisory, non-gating) ([e610523](https://github.com/SpaceK33z/autoauto/commit/e6105235c0927f51a9f6eb1a21c35d136ec37d00))
* add setup agent with system prompt, tools, and ideation mode ([16b94ae](https://github.com/SpaceK33z/autoauto/commit/16b94ae1268074199d0c79571087654436059dcb))
* add setup mode chooser with codebase analysis option ([db1d943](https://github.com/SpaceK33z/autoauto/commit/db1d9437c13afcbed8a3933c291143f48f7df5de))
* add simplicity criterion — auto-keep experiments that simplify code ([76d830e](https://github.com/SpaceK33z/autoauto/commit/76d830eaef5bb57b9584fdbea8a9df45c1f73c97))
* add tool status parsing, phase-aware indicators, and detach ([dfd6893](https://github.com/SpaceK33z/autoauto/commit/dfd6893de47bf2e16f868be209be25963da6592c))
* add TUI execution dashboard with stats, results table, and agent panel ([d46da14](https://github.com/SpaceK33z/autoauto/commit/d46da149801dfe57e943c2db0c6fd07dc75517e0))
* allow deferred finalize on completed runs ([39b3532](https://github.com/SpaceK33z/autoauto/commit/39b3532a6488c19ae5ec054ed37eb06bf3dda563))
* initial project scaffolding with OpenTUI + Claude Agent SDK ([2011300](https://github.com/SpaceK33z/autoauto/commit/201130012fec2585384e272d4757734a3a061615))
* make agent max_turns configurable per-program (default 50) ([2a84da0](https://github.com/SpaceK33z/autoauto/commit/2a84da08aa9cc8f5a4dbcd0a1e78dc495a50789c))
* make max_experiments required instead of optional ([849cb2b](https://github.com/SpaceK33z/autoauto/commit/849cb2bc44370534da7261628989292fd36b691d))
* redesign home screen with programs and runs panels ([29b6771](https://github.com/SpaceK33z/autoauto/commit/29b67713b3f64c65f0784db101fa3f395197bf17))
* render agent responses as markdown with syntax highlighting ([128b796](https://github.com/SpaceK33z/autoauto/commit/128b796d368543fe1c05a2a5762d8b8c0717fa34))
* replace cleanup with finalize — group experiments into independent branches ([b723a6f](https://github.com/SpaceK33z/autoauto/commit/b723a6f17132e804a986327e3a941083b0897a93))
* replace input with multiline textarea and auto-focus on typing ([be02739](https://github.com/SpaceK33z/autoauto/commit/be027393505077d6914bf42db252d7d9b79a8698))
* separate build from measurement, add animated tool status, and improve setup UX ([fc9b6f7](https://github.com/SpaceK33z/autoauto/commit/fc9b6f7884df7c96d07416224d72d7bccc90b5e8))
* show model label in setup/update chat title ([3241c97](https://github.com/SpaceK33z/autoauto/commit/3241c972528160ed39af528ce7e2fbc33ba1f57e))
* sort programs by most recently used run on home screen ([f4a7e97](https://github.com/SpaceK33z/autoauto/commit/f4a7e9719ccebf1e01bcb7d79949bc57ffad4b7f))


### Bug Fixes

* add contextual guidance for direct setup mode ([0d44a84](https://github.com/SpaceK33z/autoauto/commit/0d44a843418115d6b5afcca1d536bc2f630fad8b))
* add flexGrow to select components so items render visibly ([4eacda4](https://github.com/SpaceK33z/autoauto/commit/4eacda4c47f7e2fd033f6e91ab1f54c050497298))
* add missing maybeRebaseline call after no_commit/agent_error outcomes ([06c9eeb](https://github.com/SpaceK33z/autoauto/commit/06c9eeb267823f79f3af0d6cb2829d26bcf09ba1))
* apply OpenTUI best practices across TUI components ([0d13b06](https://github.com/SpaceK33z/autoauto/commit/0d13b0658585638e2d752586409bfd52d93f6bb5))
* auto-stage .gitignore after adding .autoauto entry ([fe5b5f1](https://github.com/SpaceK33z/autoauto/commit/fe5b5f1f7b1568f7630e0165151eb3b12711aa89))
* daemon agent provider init, stats header emoji width glitch, mktemp macOS guidance ([811efed](https://github.com/SpaceK33z/autoauto/commit/811efed999af20056095398eb6a33270e5eae7a8))
* improve tool event display with abbreviated paths ([f957fe1](https://github.com/SpaceK33z/autoauto/commit/f957fe1598761f2bf174e1dfdddece0e7a57401a))
* kill child processes on ralph.sh exit to prevent orphaned claude sessions ([854d788](https://github.com/SpaceK33z/autoauto/commit/854d7883d140d106f3e0d37b8155291d45d0f869))
* navigate to setup screen after first-time configuration ([68d896c](https://github.com/SpaceK33z/autoauto/commit/68d896c538c4c7930f58d8f68e162894cea228a5))
* poll stream file in daemon watcher for macOS reliability ([cfd9f72](https://github.com/SpaceK33z/autoauto/commit/cfd9f7206238f56cf82d42033ded7dad94ff9179))
* **prompts:** restrict update agent to program files, fix step numbering ([d6a2707](https://github.com/SpaceK33z/autoauto/commit/d6a2707f36682084026d6396e09e7ae8fa99b326))
* review fixes for phase-1 ([faf1043](https://github.com/SpaceK33z/autoauto/commit/faf1043ca323469d74e06ae428951322895b0110))
* setup agent noise_threshold guidance for discrete/near-ceiling metrics ([f4984e0](https://github.com/SpaceK33z/autoauto/commit/f4984e057cb0e70ac85eab3a19357ad95baf8e4b))
* **setup:** await reference file writes before rendering Chat ([053e3fa](https://github.com/SpaceK33z/autoauto/commit/053e3fab80c51640f878c54d1f55fd6bfa06df7f))
* show detailed tool status in agent panel instead of generic labels ([c2666d8](https://github.com/SpaceK33z/autoauto/commit/c2666d8db5dc21b25830b0f409f78b6f52e03341))
* show rich tool status for OpenCode provider ([d8f613d](https://github.com/SpaceK33z/autoauto/commit/d8f613d18011ef13eebc80707ee6e2b53623e6a3))
* structured secondary_values JSON, table columns, and value labeling ([d40cc24](https://github.com/SpaceK33z/autoauto/commit/d40cc241007fad85dc2f41bbae01cbe371122711))
* use select component for program list to show clear selection highlight ([3597035](https://github.com/SpaceK33z/autoauto/commit/35970358411a672bf6df6e0f2741af43d76c5290))
* wrap StatsHeader text elements in box for proper line separation ([7d4aee0](https://github.com/SpaceK33z/autoauto/commit/7d4aee031e52c5d7e8ff36a387449c39eb65f047))
